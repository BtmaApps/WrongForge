/**
 * Offline test of the HTTP API (src/server.ts): auth, SSE event stream,
 * JSON mode, sessions, validation. A fake Anthropic server answers the LLM
 * calls; the `ls` tool really runs locally.
 *
 *   npx tsx test/server.test.ts
 */

import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ClaudeOAuth } from "../src/oauth.js";
import { createAgentServer } from "../src/server.js";
import { createApp } from "../src/app.js";
import { DEFAULT_MODEL } from "../src/agent.js";

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`event: ${String((obj as any).type)}\ndata: ${JSON.stringify(obj)}\n\n`);
}

function head(res: http.ServerResponse, id: string): void {
  sse(res, {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model: DEFAULT_MODEL,
      content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 },
    },
  });
}

function toolUse(res: http.ServerResponse): void {
  head(res, "msg_tool");
  sse(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_srv", name: "ls", input: {} } });
  sse(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"."}' } });
  sse(res, { type: "content_block_stop", index: 0 });
  sse(res, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
  sse(res, { type: "message_stop" });
  res.end();
}

function text(res: http.ServerResponse, t: string): void {
  head(res, "msg_text");
  sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
  sse(res, { type: "content_block_stop", index: 0 });
  sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
  sse(res, { type: "message_stop" });
  res.end();
}

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

/** Parses an SSE body into [{event, data}]. */
function parseSse(body: string): { event: string; data: any }[] {
  return body
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const ev = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      return { event: ev, data: JSON.parse(data) };
    });
}

async function main(): Promise<void> {
  const llmBodies: any[] = [];
  const fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/v1/oauth/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "at-srv", refresh_token: "rt-srv", expires_in: 3600, scope: "user:inference" }));
        return;
      }
      if (req.url?.startsWith("/v1/messages")) {
        const parsed = JSON.parse(body);
        llmBodies.push(parsed);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const last = JSON.stringify(parsed.messages[parsed.messages.length - 1]);
        if (last.includes("tool_result")) text(res, "done listing");
        else toolUse(res);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fport = (fake.address() as any).port;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${fport}/v1/oauth/token`;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fport}/v1`;
  process.env.CLAUDE_OAUTH_CLIENT_ID = "test-client-id";

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongminiagent-srv-"));
  process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  const oauth = new ClaudeOAuth(path.join(tmp, "tokens.json"));
  await oauth.exchangeCode("c", "v", "https://console.anthropic.com/oauth/code/callback", "user:inference");

  const KEY = "test-api-key-123456789";
  const app = createApp({ oauth, apiKey: KEY });
  const api = createAgentServer({ apiKey: KEY, oauth, app });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(api.address() as any).port}`;
  const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  try {
    // health: no auth needed
    let r = await fetch(`${base}/health`);
    assert(r.status === 200 && (await r.json()).ok === true, "health ok");

    // auth
    r = await fetch(`${base}/v1/tools`);
    assert(r.status === 401, "no key -> 401");
    r = await fetch(`${base}/v1/tools`, { headers: { Authorization: "Bearer wrong-key-wrong-key" } });
    assert(r.status === 401, "wrong key -> 401");
    r = await fetch(`${base}/v1/tools`, { headers: auth });
    const tools = (await r.json()).tools.map((t: any) => t.name);
    assert(tools.includes("bash") && tools.includes("web_fetch"), "tools listed");

    // validation
    r = await fetch(`${base}/v1/run`, { method: "POST", headers: auth, body: "{}" });
    assert(r.status === 400, "missing prompt -> 400");
    r = await fetch(`${base}/v1/run`, { method: "POST", headers: auth, body: "{nope" });
    assert(r.status === 400, "bad JSON -> 400");

    // SSE run: every tool call is streamed
    r = await fetch(`${base}/v1/run`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ prompt: "list files", session_id: "s1" }),
    });
    assert(r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/event-stream"), "SSE content-type");
    const ev = parseSse(await r.text());
    const names = ev.map((e) => e.event);
    assert(names[0] === "start" && ev[0]!.data.session_id === "s1", "first event is start");
    const iCall = names.indexOf("tool_call");
    const iRes = names.indexOf("tool_result");
    const iText = names.indexOf("text");
    assert(iCall > 0 && iRes > iCall && iText > iRes, "order: tool_call -> tool_result -> text");
    assert(ev[iCall]!.data.name === "ls" && ev[iCall]!.data.input.path === ".", "tool_call carries name+input");
    assert(ev[iRes]!.data.id === ev[iCall]!.data.id, "tool_result id matches tool_call id");
    assert(ev[iRes]!.data.output?.ok === true, "tool really ran (ls output)");
    const done = ev[ev.length - 1]!;
    assert(done.event === "done" && done.data.text === "done listing" && done.data.tool_calls === 1, "done event");

    // session continuation (JSON mode) — history from the first run is sent to the LLM
    const before = llmBodies.length;
    r = await fetch(`${base}/v1/run`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ prompt: "again", session_id: "s1", stream: false }),
    });
    const j = await r.json();
    assert(r.status === 200 && j.text === "done listing", "JSON mode response");
    assert(Array.isArray(j.events) && j.events.some((e: any) => e.type === "tool_call"), "JSON mode includes events");
    const firstReq = JSON.stringify(llmBodies[before].messages);
    assert(firstReq.includes("list files") && firstReq.includes("again"), "session history carried over");

    // sessions
    r = await fetch(`${base}/v1/sessions`, { headers: auth });
    const list = (await r.json()).sessions;
    assert(list.length === 1 && list[0].id === "s1" && list[0].messages > 4, "session listed");
    r = await fetch(`${base}/v1/sessions/s1`, { method: "DELETE", headers: auth });
    assert(r.status === 200, "session deleted");
    r = await fetch(`${base}/v1/sessions/s1`, { method: "DELETE", headers: auth });
    assert(r.status === 404, "deleting again -> 404");

    console.log("SERVER TESTS PASSED ✓ (auth, SSE tool stream, JSON mode, sessions)");
  } finally {
    api.close();
    fake.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
