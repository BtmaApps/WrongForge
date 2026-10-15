/**
 * In-process REPL tests for main.ts (stdin swapped for a PassThrough, so the
 * real command handlers, turn loop and footers run under coverage reliably).
 *
 *   npx tsx test/repl.test.ts
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../src/main.js";
import { ClaudeOAuth } from "../src/oauth.js";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-repl-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

interface MockOpts {
  text?: string;
  toolName?: string;
  status?: number;
  inputTokens?: number;
}

function mockAnthropic(opts: MockOpts): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "user:inference" }));
      return;
    }
    if (req.url === "/api/oauth/usage") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
          limits: [{ kind: "session", group: "session", percent: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString(), is_active: true }],
          extra_usage: { is_enabled: false },
        }),
      );
      return;
    }
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ type: "model", id: "live-model-x", display_name: "X", created_at: "2026-01-01" }], has_more: false }));
      return;
    }
    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    if (opts.status && opts.status !== 200) {
      res.writeHead(opts.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "mock boom" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const w = (o: unknown) => res.write(`event: ${String((o as { type: string }).type)}\ndata: ${JSON.stringify(o)}\n\n`);
    w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: opts.inputTokens ?? 9, output_tokens: 1 } } });
    if (opts.toolName) {
      w({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: opts.toolName, input: {} } });
      w({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
      w({ type: "content_block_stop", index: 0 });
    } else {
      w({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      w({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: opts.text ?? "OK" } });
      w({ type: "content_block_stop", index: 0 });
    }
    w({ type: "message_delta", delta: { stop_reason: opts.toolName ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } });
    w({ type: "message_stop" });
    res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: (server.address() as { port: number }).port, close: () => server.close() })));
}

interface ReplRun {
  out: string;
  home: string;
}

/** Runs main() in-process with piped lines fed at intervals; /exit ends it. */
async function runRepl(lines: string[], mockPort: number, opts: { signedIn?: boolean; env?: Record<string, string> } = {}): Promise<ReplRun> {
  const home = path.join(tmp, `h-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(home, { recursive: true });
  if (opts.signedIn !== false) {
    const prev = { ...process.env };
    process.env.WRONGFORGE_HOME = home;
    process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${mockPort}/v1/oauth/token`;
    process.env.CLAUDE_OAUTH_CLIENT_ID = "t";
    const cc = path.join(home, "cc.json");
    fs.writeFileSync(cc, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
    new ClaudeOAuth(path.join(home, "tokens.json")).importFromClaudeCode(cc);
    Object.assign(process.env, prev);
  }
  const prevEnv = { ...process.env };
  process.env.WRONGFORGE_HOME = home;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${mockPort}/v1/oauth/token`;
  process.env.CLAUDE_OAUTH_CLIENT_ID = "t";
  process.env.NO_COLOR = "1";
  Object.assign(process.env, opts.env ?? {});

  const realStdin = process.stdin;
  const fakeIn = new PassThrough();
  Object.defineProperty(process, "stdin", { value: fakeIn, configurable: true });
  const logs: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const write = process.stdout.write.bind(process.stdout);
  const realWrite = process.stdout.write;
  process.stdout.write = ((c: unknown) => {
    logs.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" ") + "\n");
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" ") + "\n");

  let done: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const mainPromise = main([]);
  mainPromise.then(() => done());
  // feed lines with spacing so async turns settle between them
  for (const line of lines) {
    await new Promise((r) => setTimeout(r, line.startsWith("/") ? 150 : 2_500));
    fakeIn.write(line + "\n");
  }
  await Promise.race([finished, new Promise((r) => setTimeout(r, 20_000))]);
  fakeIn.write("/exit\n");
  fakeIn.end();
  try {
    await Promise.race([mainPromise, new Promise((r) => setTimeout(r, 10_000))]);
  } catch {
    /* main may reject on aborted streams */
  }

  Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
  process.stdout.write = realWrite;
  void write;
  console.log = realLog;
  console.error = realErr;
  Object.assign(process.env, prevEnv);
  return { out: logs.join(""), home };
}

async function main(): Promise<void> {
  // ======================================================== signed-in session
  const ok = await mockAnthropic({ text: "OK" });
  const r1 = await runRepl(
    ["/help", "/status", "/tools", "/usage", "/model claude-haiku-5-5", "/reset", "/nope", "/models", "say exactly OK"],
    ok.port,
  );
  assert(r1.out.includes("/help"), "repl: help");
  assert(r1.out.includes("signedIn"), "repl: status");
  assert(r1.out.includes("bash"), "repl: tools");
  assert(r1.out.includes("5h session 12%"), "repl: usage summary");
  assert(r1.out.includes("claude-haiku-5-5"), "repl: model switch");
  assert(r1.out.includes("history cleared"), "repl: reset");
  assert(r1.out.includes("unknown command"), "repl: unknown");
  assert(r1.out.includes("live-model-x"), "repl: live models");
  assert(r1.out.includes("OK") && r1.out.includes("end_turn"), "repl: turn + footer");

  // context guard path inside the REPL turn
  // ======================================================== failing turn
  const bad = await mockAnthropic({ status: 500 });
  const r2 = await runRepl(["trigger"], bad.port);
  assert(r2.out.includes("[error]"), "repl: api error printed");

  // ======================================================== unknown tool
  const tool = await mockAnthropic({ toolName: "no_such_tool" });
  const r3 = await runRepl(["call it"], tool.port);
  assert(r3.out.includes("no_such_tool") && r3.out.includes("tool error"), "repl: unknown tool error");

  // ======================================================== not signed in
  const none = await mockAnthropic({});
  const r4 = await runRepl(["hi there"], none.port, { signedIn: false });
  assert(r4.out.includes("No session found"), "repl: unsigned banner");
  assert(r4.out.includes("npm run import"), "repl: unsigned help text");

  // models when unsigned (known fallback) — cmd mode exits immediately
  const prevEnv = { ...process.env };
  const home5 = path.join(tmp, "unsigned-home");
  fs.mkdirSync(home5, { recursive: true });
  process.env.WRONGFORGE_HOME = home5;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${none.port}/v1/oauth/token`;
  process.env.CLAUDE_OAUTH_CLIENT_ID = "t";
  const logs5: string[] = [];
  const realLog5 = console.log;
  console.log = (...a: unknown[]) => logs5.push(a.map(String).join(" "));
  await main(["models"]);
  console.log = realLog5;
  Object.assign(process.env, prevEnv);
  assert(logs5.join("").includes("claude-sonnet-5-5"), "cmd models: unsigned fallback");

  // url subcommand
  const logs6: string[] = [];
  const realErr6 = console.error;
  console.log = (...a: unknown[]) => logs6.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs6.push(a.map(String).join(" "));
  await main(["url"]);
  console.error = realErr6;
  assert(logs6.join("").includes("https://"), "cmd url prints authorize url");

  // status subcommand (signed in)
  {
    const home7 = path.join(tmp, "status-home");
    fs.mkdirSync(home7, { recursive: true });
    const prev = { ...process.env };
    process.env.WRONGFORGE_HOME = home7;
    process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${ok.port}/v1/oauth/token`;
    process.env.CLAUDE_OAUTH_CLIENT_ID = "t";
    const cc = path.join(home7, "cc.json");
    fs.writeFileSync(cc, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
    new ClaudeOAuth(path.join(home7, "tokens.json")).importFromClaudeCode(cc);
    const logs7: string[] = [];
    const realLog7 = console.log;
    console.log = (...a: unknown[]) => logs7.push(a.map(String).join(" "));
    await main(["status"]);
    console.log = realLog7;
    Object.assign(process.env, prev);
    assert(logs7.join("").includes("signedIn"), "cmd status");
  }

  // import subcommand with a fake CC credentials file
  {
    const home8 = path.join(tmp, "import-home");
    fs.mkdirSync(home8, { recursive: true });
    const cc8 = path.join(home8, "cc.json");
    fs.writeFileSync(cc8, JSON.stringify({ claudeAiOauth: { accessToken: "i", refreshToken: "ir", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
    const prev = { ...process.env };
    process.env.WRONGFORGE_HOME = home8;
    const logs8: string[] = [];
    const realLog8 = console.log;
    console.log = (...a: unknown[]) => logs8.push(a.map(String).join(" "));
    await main(["import", cc8]);
    console.log = realLog8;
    Object.assign(process.env, prev);
    assert(logs8.join("").includes("imported"), "cmd import");
  }

  // CLAUDE_MODEL default
  const r9 = await runRepl([], ok.port, { env: { CLAUDE_MODEL: "claude-opus-5-5" } });
  assert(r9.out.includes("claude-opus-5-5"), "repl: CLAUDE_MODEL default");

  ok.close();
  bad.close();
  tool.close();
  none.close();
  console.log("REPL TESTS PASSED ✓ (commands, turns, errors, unsigned, subcommands)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
