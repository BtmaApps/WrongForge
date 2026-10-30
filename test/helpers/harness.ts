/**
 * Test harness: a fake Anthropic API + the real WrongForge server on top of it.
 *
 * The fake model is steered by directives inside the prompt (the LAST user
 * message), so one script serves many scenarios:
 *
 *   [[tool NAME {json input}]]   call a tool (several = parallel calls in one step)
 *   [[say TEXT]]                 final answer text (default "done" / "ok")
 *   [[delay MS]]                 wait this long before every reply
 *   [[usage N]]                  report N input tokens (context size) on every reply
 *   [[fail STATUS MESSAGE]]      answer with an HTTP error instead
 *
 * Requests whose system prompt is the compaction summarizer get a canned summary.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeOAuth } from "../../src/oauth.js";
import { createApp, type App, type AppOptions } from "../../src/app.js";
import { createAgentServer } from "../../src/server.js";
import { McpRegistry } from "../../src/mcp/registry.js";
import { McpStore } from "../../src/mcp/config.js";

export const assert = (cond: unknown, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fake LLM

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type Reply =
  | { kind: "text"; text: string; usage?: Usage; delayMs?: number }
  | { kind: "tools"; calls: { name: string; input: unknown }[]; text?: string; usage?: Usage; delayMs?: number }
  | { kind: "error"; status: number; message: string };

export interface FakeCtx {
  body: any;
  n: number;
  headers: http.IncomingHttpHeaders;
  /** Text of the last user message that carries real text (the task prompt). */
  promptText: string;
  /** The last message is a tool result: the model is being asked to wrap up. */
  afterTools: boolean;
  isSummary: boolean;
}

export type Script = (ctx: FakeCtx) => Reply | Promise<Reply>;

interface Directives {
  tools: { name: string; input: unknown }[];
  say?: string;
  delay?: number;
  usage?: number;
  fail?: { status: number; message: string };
}

function parseDirectives(text: string): Directives {
  const d: Directives = { tools: [] };
  // payload = anything up to the first "]]" (JSON arrays inside are fine)
  for (const m of text.matchAll(/\[\[(\w+)(?: ((?:(?!\]\]).)*))?\]\]/g)) {
    const [, kind, rest = ""] = m;
    if (kind === "tool") {
      const sp = rest.indexOf(" ");
      const name = sp < 0 ? rest : rest.slice(0, sp);
      d.tools.push({ name, input: sp < 0 ? {} : JSON.parse(rest.slice(sp + 1)) });
    } else if (kind === "say") d.say = rest;
    else if (kind === "delay") d.delay = Number(rest);
    else if (kind === "usage") d.usage = Number(rest);
    else if (kind === "fail") {
      const sp = rest.indexOf(" ");
      d.fail = { status: Number(rest.slice(0, sp)), message: rest.slice(sp + 1) };
    }
  }
  return d;
}

const blocksOf = (content: unknown): any[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];

export const defaultScript: Script = (ctx) => {
  if (ctx.isSummary) return { kind: "text", text: "SUMMARY: the earlier turns were summarized.", usage: { input: 50, output: 10 } };
  const d = parseDirectives(ctx.promptText);
  if (d.fail) return { kind: "error", status: d.fail.status, message: d.fail.message };
  const usage: Usage = { input: d.usage ?? 100, output: 20 };
  if (ctx.afterTools) return { kind: "text", text: d.say ?? "done", usage, delayMs: d.delay };
  if (d.tools.length) return { kind: "tools", calls: d.tools, usage, delayMs: d.delay };
  return { kind: "text", text: d.say ?? "ok", usage, delayMs: d.delay };
};

/** Every real Anthropic /v1/messages response carries these (success or
 *  error) — fixed stand-ins so proxy.test.ts can assert the dashboard tap's
 *  response_headers actually captures them, without the fake pretending to
 *  track a real quota. */
const FAKE_RATELIMIT_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-requests-limit": "50",
  "anthropic-ratelimit-requests-remaining": "42",
  "anthropic-ratelimit-tokens-limit": "20000",
  "anthropic-ratelimit-tokens-remaining": "18100",
  "request-id": "req_fake_000000000000000000000",
};

export class Fake {
  requests: { body: any; headers: http.IncomingHttpHeaders; n: number; method: string; url: string }[] = [];
  script: Script = defaultScript;
  tokenCalls = 0;
  readonly server: http.Server;
  port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => void this.handle(req, res, Buffer.concat(chunks).toString("utf8")));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Requests that are real task turns (not summaries). */
  turns(): { body: any; headers: http.IncomingHttpHeaders; n: number; method: string; url: string }[] {
    return this.requests.filter((r) => !JSON.stringify(r.body.system ?? "").includes("compress the history"));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
    if (req.url === "/v1/oauth/token") {
      this.tokenCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "at-test", refresh_token: "rt-test", expires_in: 3600, scope: "user:inference user:profile" }));
      return;
    }
    // proxy-surface support: count_tokens + models (before the /v1/messages
    // prefix match below — /v1/messages/count_tokens starts with /v1/messages).
    // Paths compare without the query: provider.ts appends ?beta=true.
    const pathOnly = (req.url ?? "").split("?")[0];
    if (pathOnly === "/v1/messages/count_tokens") {
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* count with whatever arrived */
      }
      this.requests.push({ body, headers: req.headers, n: this.requests.length + 1, method: req.method ?? "", url: req.url ?? "" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }
    if (req.method === "GET" && (pathOnly === "/v1/models" || /^\/v1\/models\/[^/]+$/.test(pathOnly))) {
      this.requests.push({ body: null, headers: req.headers, n: this.requests.length + 1, method: req.method ?? "", url: req.url ?? "" });
      const all = [
        { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
        { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
        { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
      ];
      const id = /^\/v1\/models\/(.+)$/.exec(pathOnly)?.[1];
      if (id) {
        const one = all.find((m) => m.id === id);
        if (!one) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `model: ${id}` } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(one));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: all, first_id: all[0]!.id, last_id: all[all.length - 1]!.id, has_more: false }));
      return;
    }
    if (!req.url?.startsWith("/v1/messages")) return void res.writeHead(404).end();

    const body = JSON.parse(raw);
    const n = this.requests.length + 1;
    this.requests.push({ body, headers: req.headers, n, method: req.method ?? "", url: req.url ?? "" });

    const msgs: any[] = body.messages ?? [];
    const last = msgs[msgs.length - 1];
    const afterTools = blocksOf(last?.content).some((b) => b.type === "tool_result");
    let promptText = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      const t = blocksOf(msgs[i].content).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (t) {
        promptText = t;
        break;
      }
    }
    const isSummary = JSON.stringify(body.system ?? "").includes("compress the history");

    let reply: Reply;
    try {
      reply = await this.script({ body, n, headers: req.headers, promptText, afterTools, isSummary });
    } catch (e) {
      reply = { kind: "error", status: 500, message: `fake script crashed: ${(e as Error).message}` };
    }

    if (reply.kind === "error") {
      res.writeHead(reply.status, { "Content-Type": "application/json", ...FAKE_RATELIMIT_HEADERS });
      res.end(JSON.stringify({ type: "error", error: { type: reply.status === 400 ? "invalid_request_error" : "api_error", message: reply.message } }));
      return;
    }
    if (reply.delayMs) {
      let closed = false;
      res.on("close", () => (closed = true));
      await sleep(reply.delayMs);
      if (closed) return;
    }
    // non-streaming clients (the proxy surface) get the same reply as a
    // complete Message object instead of the SSE event sequence
    if (body.stream !== true) {
      this.jsonMessage(res, reply, n, body.model);
      return;
    }
    this.sse(res, reply, n);
  }

  /** The non-streaming counterpart of sse(): one finished Message JSON. */
  private jsonMessage(res: http.ServerResponse, reply: Exclude<Reply, { kind: "error" }>, n: number, model: unknown): void {
    const u = reply.usage ?? { input: 100, output: 20 };
    const content: any[] = [];
    const text = reply.kind === "text" ? reply.text : reply.text;
    if (text) content.push({ type: "text", text });
    if (reply.kind === "tools") {
      reply.calls.forEach((c, i) => content.push({ type: "tool_use", id: `toolu_${n}_${i}`, name: c.name, input: c.input }));
    }
    res.writeHead(200, { "Content-Type": "application/json", ...FAKE_RATELIMIT_HEADERS });
    res.end(
      JSON.stringify({
        id: `msg_${n}`, type: "message", role: "assistant", model: typeof model === "string" ? model : "fake",
        content, stop_reason: reply.kind === "tools" ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: u.input, output_tokens: u.output },
      }),
    );
  }

  private sse(res: http.ServerResponse, reply: Exclude<Reply, { kind: "error" }>, n: number): void {
    const w = (o: Record<string, unknown>): void => void res.write(`event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`);
    const u = reply.usage ?? { input: 100, output: 20 };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...FAKE_RATELIMIT_HEADERS });
    w({
      type: "message_start",
      message: {
        id: `msg_${n}`, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null,
        usage: { input_tokens: u.input, output_tokens: 1, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0 },
      },
    });
    let idx = 0;
    const text = reply.kind === "text" ? reply.text : reply.text;
    if (text) {
      w({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      w({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text } });
      w({ type: "content_block_stop", index: idx });
      idx++;
    }
    if (reply.kind === "tools") {
      reply.calls.forEach((c, i) => {
        w({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: `toolu_${n}_${i}`, name: c.name, input: {} } });
        w({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
        w({ type: "content_block_stop", index: idx });
        idx++;
      });
    }
    w({ type: "message_delta", delta: { stop_reason: reply.kind === "tools" ? "tool_use" : "end_turn" }, usage: { output_tokens: u.output } });
    w({ type: "message_stop" });
    res.end();
  }
}

// -------------------------------------------------------------- HTTP helper

export interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

// ------------------------------------------------------------------ harness

export interface Harness {
  base: string;
  key: string;
  home: string;
  /** Parent of every workdir the test creates. */
  workroot: string;
  app: App;
  server: http.Server;
  fake: Fake;
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResult>;
  /** Creates (and returns the canonical path of) a directory under workroot. */
  mkdir(name: string): string;
  /** Polls a task until it reached a terminal state. */
  waitTask(id: string, timeoutMs?: number): Promise<any>;
  events(id: string, after?: number): Promise<any[]>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Reuse a data directory (restart tests). */
  home?: string;
  app?: Partial<AppOptions>;
  script?: Script;
  /** Share an existing fake (restart tests). */
  fake?: Fake;
  /** Serve this directory as the dashboard (tests the static + SPA routes). */
  webuiDir?: string;
  /** Extra named client keys (key -> client name). Absent = single-key install. */
  clientKeys?: Map<string, string>;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const fake = opts.fake ?? new Fake();
  if (!opts.fake) await fake.start();
  if (opts.script) fake.script = opts.script;

  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-it-"));
  const workroot = path.join(home, "work");
  fs.mkdirSync(workroot, { recursive: true });
  const promptDir = path.join(home, "prompts");
  fs.mkdirSync(promptDir, { recursive: true });

  process.env.ANTHROPIC_TOKEN_URL = `${fake.base}/v1/oauth/token`;
  process.env.ANTHROPIC_BASE_URL = `${fake.base}/v1`;
  process.env.CLAUDE_OAUTH_CLIENT_ID = "test-client-id";

  const oauth = new ClaudeOAuth(path.join(home, "tokens.json"));
  await oauth.exchangeCode("code", "verifier", "https://console.anthropic.com/oauth/code/callback", "user:inference user:profile");

  const key = "test-api-key-0123456789";
  const app = createApp({
    oauth,
    apiKey: key,
    home,
    heartbeatMs: 150,
    textFlushMs: 20,
    progressSaveMs: 50,
    promptDir,
    mcp: new McpRegistry({ store: new McpStore(path.join(home, "mcp.json")), idleMs: 60_000 }),
    webhook: { baseDelayMs: 20, maxDelayMs: 100, maxAttempts: 4, timeoutMs: 2000 },
    gatewayAllowedHosts: ["127.0.0.1", "localhost"],
    ...opts.app,
  });
  app.manager.recover();

  const server = createAgentServer({ apiKey: key, ...(opts.clientKeys ? { clientKeys: opts.clientKeys } : {}), oauth, app, promptDir, ...(opts.webuiDir ? { webuiDir: opts.webuiDir } : {}) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const api: Harness["api"] = async (method, p, body, headers = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON (SSE) */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  return {
    base, key, home, workroot, app, server, fake, api,
    mkdir(name) {
      const d = path.join(workroot, name);
      fs.mkdirSync(d, { recursive: true });
      return fs.realpathSync(d);
    },
    async waitTask(id, timeoutMs = 20_000) {
      const t0 = Date.now();
      for (;;) {
        const { body } = await api("GET", `/v1/tasks/${id}`);
        if (body?.task && ["completed", "failed", "cancelled", "timed_out"].includes(body.task.status)) return body.task;
        if (Date.now() - t0 > timeoutMs) throw new Error(`task ${id} did not finish in ${timeoutMs} ms (status ${body?.task?.status})`);
        await sleep(25);
      }
    },
    async events(id, after = 0) {
      const { body } = await api("GET", `/v1/tasks/${id}/events?after=${after}&limit=5000`);
      return body.events;
    },
    async close() {
      await app.manager.shutdown(3000);
      await app.mcp.closeAll();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      if (!opts.fake) await fake.close();
    },
  };
}

/** Parses an SSE body into events. */
export function parseSse(text: string): { id?: string; event: string; data: any }[] {
  return text
    .split("\n\n")
    .filter((b) => b.trim() && !b.startsWith(":"))
    .map((block) => {
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { id, event, data: data ? JSON.parse(data) : null };
    });
}

/** A tiny HTTP receiver for webhook / gateway tests. */
export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
  json: any;
}

export async function startReceiver(
  handler: (r: Received, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ url: string; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let json: any = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        /* not JSON */
      }
      const r: Received = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw, json };
      received.push(r);
      void Promise.resolve(handler(r, res));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    received,
    close: () => {
      server.closeAllConnections?.();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
