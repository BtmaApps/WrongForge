/**
 * CLI entry tests: the REPL (main.ts), the HTTP server entry (server.ts
 * isMain block), mcp-cli subcommands and init-config — every child runs
 * offline against local mock servers with its own WRONGFORGE_HOME.
 *
 *   npx tsx test/cli.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeOAuth } from "../src/oauth.js";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-cli-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// Direct node + tsx cli (no shell): the spawned pid IS the test process, so
// kill() actually works and coverage flushes on clean exits.
const TSX = process.execPath;
const TSX_ARGS = [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")];

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

function run(file: string, args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string; timeoutMs?: number; keepStdin?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stripped = { ...process.env };
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_TOKEN_URL", "CLAUDE_OAUTH_CLIENT_ID", "ANTHROPIC_API_KEY"]) delete stripped[k];
    const env: NodeJS.ProcessEnv = {
      ...stripped,
      NO_COLOR: "1",
      WRONGFORGE_HOME: path.join(tmp, `home-${Math.random().toString(36).slice(2, 8)}`),
      ...opts.env,
    };
    const child: ChildProcess = spawn(TSX, [...TSX_ARGS, file, ...args], {
      env,
      cwd: opts.cwd ?? ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    const killer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill();
      }
    }, opts.timeoutMs ?? 30_000);
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    if (!opts.keepStdin) child.stdin?.end();
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, out, err });
    });
  });
}

/** Minimal mock: /v1/oauth/token + /v1/messages (SSE "OK") + /api/oauth/usage. */
function mockAnthropic(): Promise<{ port: number; close: () => void; bodies: any[] }> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (req.url === "/v1/oauth/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "user:inference" }));
        return;
      }
      if (req.url === "/api/oauth/usage") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
            limits: [{ kind: "session", group: "session", percent: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString(), is_active: true }],
            extra_usage: { is_enabled: false },
          }),
        );
        return;
      }
      if (req.url?.startsWith("/v1/messages")) {
        bodies.push(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const w = (o: unknown) => res.write(`event: ${String((o as { type: string }).type)}\ndata: ${JSON.stringify(o)}\n\n`);
        w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } } });
        w({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        w({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } });
        w({ type: "content_block_stop", index: 0 });
        w({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
        w({ type: "message_stop" });
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: (server.address() as { port: number }).port, close: () => server.close(), bodies })));
}

/** Kills a shell-spawned child AND its process tree (Windows-safe). */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}

/** Picks a currently-free TCP port (bind + close). */
function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

async function main(): Promise<void> {
  // ======================================================== init-config
  const cfgHome = path.join(tmp, "cfg-home");
  const r1 = await run("src/init-config.ts", [], { env: { WRONGFORGE_HOME: cfgHome } });
  assert(r1.code === 0 && fs.existsSync(path.join(cfgHome, "oauth.json")), "init-config writes oauth.json");
  const r2 = await run("src/init-config.ts", [], { env: { WRONGFORGE_HOME: cfgHome } });
  assert(r2.out.includes("already exists"), "init-config idempotent message");

  // paths: legacy migration (homedir with .wrongminiagent, no .wrongforge)
  const fakeHome = path.join(tmp, "fake-home");
  const legacy = path.join(fakeHome, ".wrongminiagent");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "legacy-marker.txt"), "x");
  const env3: Record<string, string> = { USERPROFILE: fakeHome, HOMEPATH: "", HOMEDRIVE: "", WRONGFORGE_HOME: "" };
  const r3 = await run("src/init-config.ts", [], { env: env3 });
  assert(r3.code === 0 && fs.existsSync(path.join(fakeHome, ".wrongforge", "oauth.json")), "legacy .wrongminiagent migrated to .wrongforge");
  assert(fs.existsSync(path.join(legacy, "legacy-marker.txt")), "legacy dir left in place");

  // ======================================================== server entry
  const mock = await mockAnthropic();
  const srvHome = path.join(tmp, "srv-home");
  const srvEnv: Record<string, string> = {
    WRONGFORGE_HOME: srvHome,
    AGENT_API_KEY: "cli-test-key-1234567890",
    PORT: String(await freePort()),
    HOST: "127.0.0.1",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
    ANTHROPIC_TOKEN_URL: `http://127.0.0.1:${mock.port}/v1/oauth/token`,
    CLAUDE_OAUTH_CLIENT_ID: "cli-test",
  };
  // seed a token into the child's home first (exchange against the mock)
  {
    const prev = { ...process.env };
    process.env.WRONGFORGE_HOME = srvHome;
    process.env.ANTHROPIC_TOKEN_URL = srvEnv.ANTHROPIC_TOKEN_URL;
    process.env.CLAUDE_OAUTH_CLIENT_ID = "cli-test";
    const oauth = new ClaudeOAuth(path.join(srvHome, "tokens.json"));
    const cc = path.join(tmp, "cc.json");
    fs.writeFileSync(cc, JSON.stringify({ claudeAiOauth: { accessToken: "s", refreshToken: "r", expiresAt: Date.now() - 1000, scopes: ["user:inference"] } }));
    oauth.importFromClaudeCode(cc);
    Object.assign(process.env, prev);
  }
  // Real server entry, exercised in a CHILD process (clean exit → coverage
  // flushes; isolation keeps this suite's later spawns untouched).
  const entry = await run("test/helpers/entry-runner.ts", [], {
    env: { ...srvEnv, WF_ENTRY_WORKDIR: tmp },
    timeoutMs: 90_000,
  });
  assert(entry.code === 0 && entry.out.includes("ENTRY-OK"), `server entry child: ${entry.out.slice(-300)} ${entry.err.slice(-300)}`);

  // EADDRINUSE: two servers on one fixed port
  const fixed = await freePort();
  const s1 = spawn(TSX, [...TSX_ARGS, "src/server.ts"], {
    env: { ...process.env, ...srvEnv, PORT: String(fixed), AGENT_API_KEY: "long-enough-key-1" },
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  let s1up = false;
  let srvOut2 = "";
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 40_000);
    s1.stdout.on("data", (d: Buffer) => (srvOut2 += d.toString()));
    s1.stdout.on("data", (d: Buffer) => {
      if (d.toString().includes(String(fixed))) {
        s1up = true;
        clearTimeout(t);
        resolve();
      }
    });
    s1.on("close", () => { clearTimeout(t); resolve(); });
  });
  if (!s1up) console.error("S1OUT:", srvOut2.slice(0, 600));
  assert(s1up, "first fixed-port server up");
  const r_dup = await run("src/server.ts", [], { env: { ...srvEnv, PORT: String(fixed) }, timeoutMs: 40_000 });
  assert(r_dup.code === 1 && (r_dup.out + r_dup.err).includes("already in use"), "EADDRINUSE exits with message");
  killTree(s1);

  // too-short AGENT_API_KEY is refused with a clear message
  const r_short = await run("src/server.ts", [], { env: { ...srvEnv, AGENT_API_KEY: "k1" }, timeoutMs: 40_000 });
  assert(r_short.code === 1, "short AGENT_API_KEY exits 1");

  // ======================================================== REPL (main.ts)
  const replHome = path.join(tmp, "repl-home");
  {
    const prev = { ...process.env };
    process.env.WRONGFORGE_HOME = replHome;
    process.env.ANTHROPIC_TOKEN_URL = srvEnv.ANTHROPIC_TOKEN_URL;
    process.env.CLAUDE_OAUTH_CLIENT_ID = "cli-test";
    const oauth = new ClaudeOAuth(path.join(replHome, "tokens.json"));
    oauth.importFromClaudeCode(path.join(tmp, "cc.json"));
    Object.assign(process.env, prev);
  }
  const replEnv: Record<string, string> = {
    WRONGFORGE_HOME: replHome,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
    ANTHROPIC_TOKEN_URL: srvEnv.ANTHROPIC_TOKEN_URL,
    CLAUDE_OAUTH_CLIENT_ID: "cli-test",
  };
  // commands-only pass: piped lines never race an async turn
  console.error("[mark] before commands run");
  const repl = await run("src/main.ts", [], {
    env: replEnv,
    input: ["/help", "/status", "/tools", "/model claude-haiku-5-5", "/reset", "/nope", "/usage", "/exit"].join("\n"),
    timeoutMs: 60_000,
  });
  console.error("[mark] commands done, out len", repl.out.length);
  assert(repl.out.includes("claude-haiku-5-5"), "repl: /model switches");
  assert(repl.out.includes("history cleared"), "repl: /reset");
  assert(repl.out.includes("unknown command"), "repl: unknown command");
  assert(repl.out.includes("5h session") || repl.out.includes("usage unavailable"), "repl: /usage either source");
  assert(repl.out.includes("signedIn"), "repl: /status");
  assert(repl.out.includes("bash") && repl.out.includes("read"), "repl: /tools lists");
  // one real turn; stdin stays open, the timeout tree-kills the process
  console.error("[mark] before turn run");
  const turnRun = await run("src/main.ts", [], {
    env: replEnv,
    input: "say exactly OK\n",
    keepStdin: true,
    timeoutMs: 15_000,
  });
  console.error("[mark] turn done, out len", turnRun.out.length);
  assert(turnRun.out.includes("OK"), "repl: turn output");
  assert(turnRun.out.includes("end_turn"), "repl: usage footer");

  // repl without a signed-in session: /models falls back to known list
  const emptyHome = path.join(tmp, "empty-home");
  console.error("[mark] before models run");
  const fastFailAuth = { ANTHROPIC_TOKEN_URL: "http://127.0.0.1:9/token", CLAUDE_OAUTH_CLIENT_ID: "x" };
  const r_models = await run("src/main.ts", [], {
    env: { WRONGFORGE_HOME: emptyHome, ...fastFailAuth },
    input: "/models\n/exit\n",
    timeoutMs: 60_000,
  });
  console.error("[mark] models done", r_models.out.length);
  assert(r_models.out.includes("claude-sonnet-5-5"), "repl: /models known fallback");

  // repl: model from CLAUDE_MODEL env
  const r_envmodel = await run("src/main.ts", [], {
    env: { WRONGFORGE_HOME: emptyHome, CLAUDE_MODEL: "claude-opus-5-5", ...fastFailAuth },
    input: "/exit\n",
    timeoutMs: 60_000,
  });
  console.error("[mark] envmodel done");
  assert(r_envmodel.out.includes("claude-opus-5-5"), "repl: CLAUDE_MODEL env");

  // ======================================================== mcp-cli
  const mcpHome = path.join(tmp, "mcp-home");
  const mEnv = { WRONGFORGE_HOME: mcpHome };
  console.error("[mark] mcp section");
  const m_add = await run("src/mcp-cli.ts", ["add", "fs", "--command", "node", "--", "server.js"], { env: mEnv });
  assert(m_add.code === 0 && m_add.out.includes("fs"), "mcp add");
  const m_addurl = await run("src/mcp-cli.ts", ["add", "remote", "--url", "https://example.com/mcp"], { env: mEnv });
  assert(m_addurl.code === 0, "mcp add --url");
  const m_bad = await run("src/mcp-cli.ts", ["add", "broken"], { env: mEnv });
  assert(m_bad.code !== 0, "mcp add without command/url fails");
  const m_list = await run("src/mcp-cli.ts", ["list"], { env: mEnv });
  assert(m_list.out.includes("fs") && m_list.out.includes("remote"), "mcp list");
  const m_rm = await run("src/mcp-cli.ts", ["remove", "remote"], { env: mEnv });
  assert(m_rm.code === 0, "mcp remove");
  const m_path = await run("src/mcp-cli.ts", ["path"], { env: mEnv });
  assert(m_path.out.includes("mcp"), "mcp path");
  const m_help = await run("src/mcp-cli.ts", [], { env: mEnv });
  assert(m_help.out.includes("Usage"), "mcp usage/help");
  const m_unknown = await run("src/mcp-cli.ts", ["frobnicate"], { env: mEnv });
  assert(m_unknown.code !== 0, "mcp unknown command fails");

  console.error("[mark] all sections done");
  mock.close();
  console.log("CLI TESTS PASSED ✓ (init-config, paths migration, server entry, REPL, mcp-cli)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
