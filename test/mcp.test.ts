/**
 * MCP integration test — real @modelcontextprotocol/sdk client against a real (minimal) MCP
 * server, over stdio AND Streamable HTTP.
 *
 *   npx tsx test/mcp.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { runInContext } from "../src/context.js";
import { McpStore, expandEnv, redactSpec, validateSpec, McpConfigError } from "../src/mcp/config.js";
import { McpError, McpRegistry, exposedName, mapCallResult } from "../src/mcp/registry.js";
import { mcpAdd, mcpCall, mcpRemove, mcpServers, mcpTools } from "../src/tools/mcp-tools.js";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};
const throwsAsync = async (fn: () => Promise<unknown> | unknown): Promise<Error | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
};

const FIXTURE = path.join(import.meta.dirname ?? ".", "fixtures", "mini-mcp.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-mcp-"));
const children: ChildProcess[] = [];
process.on("exit", () => {
  for (const c of children) c.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function startHttpServer(token?: string): Promise<number> {
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE, "http", String(port), ...(token ? [token] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => d.toString().includes("listening") && resolve());
    child.on("error", reject);
    setTimeout(() => reject(new Error("http fixture did not start")), 10_000);
  });
  return port;
}

const callTool = (tools: any, name: string, input: unknown): Promise<any> =>
  tools[name].execute(input, { toolCallId: "t1", messages: [] });

async function main(): Promise<void> {
  // ================================================================ config
  // type inference + validation
  assert(validateSpec("a", { command: "node" }).type === "stdio", "command -> stdio");
  assert(validateSpec("a", { url: "https://x.test/mcp" }).type === "http", "url -> http");
  assert(validateSpec("a", { type: "sse", url: "http://x.test/sse" }).type === "sse", "explicit sse");
  assert(validateSpec("a", { command: "n", bogus: 1 } as never).command === "n" && !("bogus" in validateSpec("a", { command: "n", bogus: 1 } as never)), "unknown keys dropped");
  for (const [label, name, spec] of [
    ["no transport", "a", {}],
    ["bad name", "bad name!", { command: "n" }],
    ["stdio without command", "a", { type: "stdio" }],
    ["http with command", "a", { url: "http://x", command: "n" }],
    ["non-http url", "a", { url: "ftp://x" }],
    ["bad timeout", "a", { command: "n", timeout_ms: 5 }],
    ["headers not strings", "a", { url: "http://x", headers: { a: 1 } }],
  ] as const) {
    assert((await throwsAsync(() => validateSpec(name, spec))) instanceof McpConfigError, `rejects: ${label}`);
  }

  // env expansion
  assert(expandEnv("Bearer ${T}", { T: "abc" }, "x") === "Bearer abc", "expands ${VAR}");
  assert(expandEnv("${MISSING:-dflt}", {}, "x") === "dflt", "default value");
  const miss = await throwsAsync(() => expandEnv("${NOPE}", {}, "server s headers.Authorization"));
  assert(miss instanceof McpConfigError && miss.message.includes("NOPE") && miss.message.includes("server s"), "missing var -> clear error");

  // redaction
  const red = redactSpec(validateSpec("a", { url: "https://u:p@h.test/x?token=SECRET", headers: { Authorization: "Bearer LITERAL", X: "${REF}" } }));
  assert(red.headers!.Authorization === "[redacted]" && red.headers!.X === "${REF}", "literal secrets masked, ${REF} kept");
  assert(!JSON.stringify(red).includes("SECRET") && !JSON.stringify(red).includes("u:p"), "url credentials/query masked");

  // store: persist, preserve foreign keys, import, enable/disable, remove
  const file = path.join(tmp, "cfg", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ somethingElse: 42, mcpServers: { old: { command: "node" } } }));
  const store = new McpStore(file);
  assert(store.get("old")?.type === "stdio", "reads existing entry");
  store.put("new", { url: "https://x.test/mcp", description: "d" });
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert(onDisk.somethingElse === 42 && onDisk.mcpServers.new.type === "http", "writes, keeps unrelated keys");
  if (process.platform !== "win32") assert((fs.statSync(file).mode & 0o777) === 0o600, "file mode 0600");
  assert(store.setEnabled("new", false)?.enabled === false && store.get("new")?.enabled === false, "disable");
  assert(store.setEnabled("new", true)?.enabled === true, "enable");
  const imp = store.import({ mcpServers: { old: { command: "other" }, fresh: { command: "x" }, broken: { nothing: true } } });
  assert(imp.added.join() === "fresh" && imp.skipped.join() === "old" && imp.invalid[0]?.name === "broken", "import: add / skip existing / report invalid");
  assert(store.import({ old: { command: "other" } }, { overwrite: true }).updated.join() === "old" && store.get("old")?.command === "other", "import overwrite, bare map accepted");
  assert(store.remove("fresh") && !store.remove("fresh"), "remove");
  fs.writeFileSync(file, "{ not json");
  assert((await throwsAsync(() => store.readAll())) instanceof McpConfigError, "broken file -> McpConfigError, not a crash");

  // names
  assert(exposedName("gh", "create_issue") === "mcp_gh_create_issue", "exposed name");
  const long = exposedName("srv", "x".repeat(100));
  assert(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long), "long names shortened + valid charset");
  assert(exposedName("s", "a.b/c") === "mcp_s_a_b_c", "invalid chars replaced");
  assert(exposedName("s", "x".repeat(100)) !== exposedName("s", "x".repeat(101)), "shortened names stay unique");

  // result mapping
  assert(JSON.stringify(mapCallResult({ content: [{ type: "text", text: "hi" }] })) === '{"ok":true,"output":"hi"}', "text result");
  assert((mapCallResult({ content: [{ type: "text", text: "no" }], isError: true }) as any).error === "no", "isError -> ok:false");
  assert(String((mapCallResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }) as any).output).includes("image/png"), "image described, not dumped");
  assert((mapCallResult({ content: [], structuredContent: { a: 1 } }) as any).output === '{"a":1}', "structuredContent fallback");
  assert((mapCallResult({ content: [{ type: "text", text: "x".repeat(100_000) }] }) as any).truncated === true, "huge output truncated");

  // ================================================================ stdio
  const reg = new McpRegistry({ store: new McpStore(path.join(tmp, "reg.json")), idleMs: 60_000, env: { OUTER: "from-outer" } });
  reg.addServer("local", {
    command: process.execPath,
    args: [FIXTURE, "stdio"],
    env: { MINI_VAR: "${OUTER}" }, // env var reference inside the server's env
    description: "stdio fixture",
  });

  const t1 = await reg.test("local");
  assert(t1.ok && t1.server_info?.name === "mini-mcp" && t1.server_info.version === "1.2.3", "stdio: connect + serverInfo");
  assert(t1.tools.map((t) => t.name).includes("echo") && t1.instructions === "Mini MCP test server.", "stdio: tools + instructions");
  assert(reg.status().servers[0]!.connected, "stdio: connection is pooled after test");

  assert(JSON.stringify(await reg.callTool("local", "echo", { text: "hello" })) === '{"ok":true,"output":"echo: hello"}', "stdio: call echo");
  assert((await reg.callTool("local", "add", { a: 2, b: 40 })).output === "42", "stdio: call add");
  assert((await reg.callTool("local", "whoami_env", {})).output === "MINI_VAR=from-outer", "stdio: ${OUTER} expanded into the server env");
  const failed = await reg.callTool("local", "fail", {});
  assert(failed.ok === false && String(failed.error).includes("always fails"), "stdio: tool error -> ok:false");
  const unknownTool = await reg.callTool("local", "nope", {});
  assert(unknownTool.ok === false, "stdio: unknown tool -> ok:false (no throw)");
  const slow = await reg.callTool("local", "slow", { ms: 3000 }, { timeoutMs: 300 });
  assert(slow.ok === false && String(slow.error).includes("timed out"), "stdio: call timeout");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const cancelled = await reg.callTool("local", "slow", { ms: 3000 }, { signal: ac.signal });
  assert(cancelled.ok === false && String(cancelled.error).includes("cancelled"), "stdio: abort signal cancels the call");
  assert((await reg.callTool("local", "echo", { text: "still alive" })).ok === true, "stdio: connection survives timeouts/cancels");

  // eager tools
  const load = await reg.loadForTask(undefined, { taskId: "tk" });
  assert(load.servers[0]!.ok && load.defs.some((d) => d.exposed === "mcp_local_echo"), "eager: typed tools mcp_<server>_<tool>");
  assert(Object.keys(load.tools).join() === [...Object.keys(load.tools)].sort().join(), "eager: tool order is sorted (stable for the prompt cache)");
  assert(load.hash === (await reg.loadForTask(undefined, { taskId: "tk2" })).hash, "eager: hash is stable between loads");
  assert((await callTool(load.tools, "mcp_local_add", { a: 1, b: 2 })).output === "3", "eager: typed tool executes");
  assert((load.defs.find((d) => d.exposed === "mcp_local_add")!.schema as any).required.join() === "a,b", "eager: JSON schema passed through");

  // allow / deny hold for eager tools AND mcp_call
  reg.addServer("local", { command: process.execPath, args: [FIXTURE, "stdio"], deny: ["secret_*", "fail"], description: "denied" });
  const denied = await reg.loadForTask(["local"], { taskId: "tk" });
  assert(!denied.defs.some((d) => d.remote === "secret_tool" || d.remote === "fail") && denied.defs.some((d) => d.remote === "echo"), "deny hides tools from eager exposure");
  const viaCall = await reg.callTool("local", "secret_tool", {});
  assert(viaCall.ok === false && String(viaCall.error).includes("not permitted"), "deny also blocks mcp_call / direct calls");
  reg.addServer("local", { command: process.execPath, args: [FIXTURE, "stdio"], allow: ["echo", "ad*"] });
  const allowed = await reg.loadForTask(["local"], { taskId: "tk" });
  assert(allowed.defs.map((d) => d.remote).sort().join() === "add,echo", "allow keeps only matching tools (suffix wildcard)");

  // selection semantics
  reg.addServer("lazy", { command: process.execPath, args: [FIXTURE, "stdio"], eager: false });
  assert(!(await reg.loadForTask(undefined, { taskId: "t" })).servers.some((s) => s.name === "lazy"), "default selection skips eager:false servers");
  assert((await reg.loadForTask(["*"], { taskId: "t" })).servers.some((s) => s.name === "lazy"), '["*"] includes them');
  assert((await reg.loadForTask([], { taskId: "t" })).servers.length === 0, "[] selects none");

  // disabled servers
  reg.setEnabled("lazy", false);
  const dis = await reg.callTool("lazy", "echo", { text: "x" });
  assert(dis.ok === false && String(dis.error).includes("disabled"), "disabled server refuses calls");

  // ================================================================ http
  const TOKEN = "mcp-test-token-123";
  const port = await startHttpServer(TOKEN);
  const regHttp = new McpRegistry({ store: new McpStore(path.join(tmp, "http.json")), env: { MINI_TOKEN: TOKEN } });
  regHttp.addServer("remote", { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer ${MINI_TOKEN}" } });
  const th = await regHttp.test("remote");
  assert(th.ok && th.tools.length === 6, "http: connect with ${VAR} header, list tools");
  assert((await regHttp.callTool("remote", "echo", { text: "over http" })).output === "echo: over http", "http: call echo");
  assert((await regHttp.callTool("remote", "add", { a: 5, b: 6 })).output === "11", "http: call add");

  regHttp.addServer("noauth", { url: `http://127.0.0.1:${port}/mcp` });
  const na = await regHttp.test("noauth");
  assert(!na.ok && typeof na.error === "string", "http: missing credentials -> test reports failure (no throw)");

  regHttp.addServer("novar", { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer ${DEFINITELY_UNSET_VAR}" } });
  const nv = await regHttp.test("novar");
  assert(!nv.ok && String(nv.error).includes("DEFINITELY_UNSET_VAR"), "http: unset ${VAR} -> error names the variable");

  // ================================================================ failures
  reg.addServer("ghost", { command: "definitely-not-a-real-binary-xyz", startup_timeout_ms: 5000 });
  const gt = await reg.test("ghost");
  assert(!gt.ok, "unstartable stdio server -> test reports failure");
  const soft = await reg.loadForTask(["ghost", "local"], { taskId: "t" });
  assert(soft.warnings.some((w) => w.includes("ghost")) && soft.defs.some((d) => d.server === "local"), "unreachable server is skipped with a warning, others still load");
  reg.addServer("ghost", { command: "definitely-not-a-real-binary-xyz", required: true, startup_timeout_ms: 5000 });
  const hard = await throwsAsync(() => reg.loadForTask(["ghost"], { taskId: "t" }));
  assert(hard instanceof McpError && hard.code === "mcp_unavailable", "required server unreachable -> McpError(mcp_unavailable)");
  const unknown = await reg.callTool("nonexistent", "x", {});
  assert(unknown.ok === false && String(unknown.error).includes("no MCP server named"), "unknown server -> ok:false");

  // ================================================================ idle close
  const regIdle = new McpRegistry({ store: new McpStore(path.join(tmp, "idle.json")), idleMs: 150 });
  regIdle.addServer("s", { command: process.execPath, args: [FIXTURE, "stdio"] });
  await regIdle.callTool("s", "echo", { text: "x" });
  assert(regIdle.status().servers[0]!.connected, "idle: connection kept right after use");
  await new Promise((r) => setTimeout(r, 500));
  assert(!regIdle.status().servers[0]!.connected, "idle: pooled connection closed after idleMs");
  assert((await regIdle.callTool("s", "echo", { text: "again" })).ok === true, "idle: reconnects transparently");
  await regIdle.closeAll();

  // ================================================================ child ownership
  // A failed connect and a connect that crosses a shutdown must both release the
  // child process they spawned — neither may leave a live MCP server behind.
  const pidAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const pidRecorded = (file: string): Promise<number> =>
    new Promise((resolve) => {
      const t = setInterval(() => {
        if (fs.existsSync(file)) { clearInterval(t); resolve(Number(fs.readFileSync(file, "utf8").trim().split("\n")[0])); }
      }, 20);
      setTimeout(() => { clearInterval(t); resolve(0); }, 8000);
    });
  const pidGone = (pid: number, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const t = setInterval(() => { if (!pidAlive(pid)) { clearInterval(t); resolve(true); } }, 20);
      setTimeout(() => { clearInterval(t); resolve(!pidAlive(pid)); }, ms);
    });
  // a stdio server that starts, announces its pid and never answers `initialize`
  const mute = path.join(tmp, "mute.mcp.mjs");
  fs.writeFileSync(mute,
    `import * as fs from "node:fs";\nfs.writeFileSync(process.env.PIDFILE, String(process.pid));\n` +
    `process.stdin.resume();\nsetInterval(() => {}, 1000);\n`);

  const pidFile = path.join(tmp, "child.pid");
  const regLeak = new McpRegistry({ store: new McpStore(path.join(tmp, "leak.json")), env: { PIDFILE: pidFile } });
  regLeak.addServer("mute", { command: process.execPath, args: [mute], env: { PIDFILE: "${PIDFILE}" }, startup_timeout_ms: 1000 });
  const muteCall = regLeak.test("mute");           // connect starts, deliberately not awaited
  const mutePid = await pidRecorded(pidFile);      // gate: the child is up, initialize in flight
  const muteRes = await muteCall;                  // the connect attempt has now failed
  assert(!muteRes.ok, "ownership: a server that never initializes -> test reports failure");
  assert(await pidGone(mutePid, 5000), `ownership: a FAILED connect releases its child (pid ${mutePid})`);

  // closeAll()/invalidate() are a barrier: nothing may be published after they resolve
  const wrap = path.join(tmp, "wrap.mcp.mjs"); // wrapper that announces the pid of the fixture it spawns
  fs.writeFileSync(wrap,
    `import * as fs from "node:fs";\nimport { spawn } from "node:child_process";\n` +
    `const c = spawn(process.execPath, ${JSON.stringify([FIXTURE, "stdio"])}, { stdio: "inherit" });\n` +
    `fs.writeFileSync(process.env.PIDFILE, String(c.pid));\nc.on("exit", (code) => process.exit(code ?? 0));\n`);
  const barrierPidFile = path.join(tmp, "barrier.pid");
  const regBarrier = new McpRegistry({ store: new McpStore(path.join(tmp, "barrier.json")), env: { PIDFILE: barrierPidFile } });
  regBarrier.addServer("local", { command: process.execPath, args: [wrap], env: { PIDFILE: "${PIDFILE}" } });
  const inflight = regBarrier.callTool("local", "echo", { text: "mid-connect" });
  const barrierPid = await pidRecorded(barrierPidFile); // gate: the connect is still suspended
  assert(barrierPid > 0, "ownership: the barrier gate observed the child before the connect settled");
  await regBarrier.closeAll();
  const inflightRes = await inflight;                    // the connect settles only now
  assert(inflightRes.ok === false, "ownership: a call whose connect crossed closeAll() fails instead of succeeding");
  assert(!regBarrier.status().servers[0]!.connected, "ownership: closeAll() is a barrier — no connection published after it resolved");
  assert(await pidGone(barrierPid, 5000), `ownership: a connect crossing closeAll() releases its child (pid ${barrierPid})`);
  assert((await regBarrier.callTool("local", "echo", { text: "back" })).ok === true, "ownership: reconnects cleanly after closeAll()");
  await regBarrier.closeAll();

  // ================================================================ agent tools
  const agentReg = new McpRegistry({ store: new McpStore(path.join(tmp, "agent.json")), env: { MINI_TOKEN: TOKEN } });
  const inCtx = <T>(fn: () => Promise<T>): Promise<T> =>
    runInContext({ cwd: tmp, env: {}, todos: [], mcp: agentReg }, fn);
  const exec = (t: any, input: unknown): Promise<any> => inCtx(() => t.execute(input, { toolCallId: "x", messages: [] }));

  assert((await exec(mcpServers, {})).servers.length === 0, "agent: starts with no servers");
  const added = await exec(mcpAdd, { name: "mini", command: process.execPath, args: [FIXTURE, "stdio"], description: "agent-added" });
  assert(added.ok && added.connection.ok && added.connection.tools.includes("echo"), "agent: mcp_add saves AND tests the server");
  assert(agentReg.store.get("mini")?.description === "agent-added", "agent: the server is persisted in the config file");
  const listed = await exec(mcpServers, {});
  assert(listed.servers[0].name === "mini" && listed.servers[0].connected === true, "agent: mcp_servers shows it connected");
  const names = await exec(mcpTools, { server: "mini" });
  assert(names.ok && names.count === 6 && !("input_schema" in names), "agent: mcp_tools lists names without schemas");
  const one = await exec(mcpTools, { server: "mini", tool: "add" });
  assert(one.ok && one.input_schema.required.join() === "a,b", "agent: mcp_tools <tool> returns the full schema");
  assert((await exec(mcpTools, { server: "mini", tool: "zzz" })).available.includes("echo"), "agent: unknown tool name lists the available ones");
  assert((await exec(mcpCall, { server: "mini", tool: "add", input: { a: 20, b: 22 } })).output === "42", "agent: mcp_call works right after mcp_add");
  const bad = await exec(mcpAdd, { name: "bad!", command: "x" });
  assert(bad.ok === false && String(bad.error).includes("invalid server name"), "agent: invalid input -> ok:false with the reason");
  const failAdd = await exec(mcpAdd, { name: "dead", command: "definitely-not-a-real-binary-xyz", test: true });
  assert(failAdd.ok && failAdd.connection.ok === false && String(failAdd.note).includes("failed"), "agent: saved-but-unreachable is reported honestly");

  process.env.WRONGFORGE_MCP_AGENT_MANAGE = "0";
  assert(String((await exec(mcpAdd, { name: "x2", command: "n" })).error).includes("disabled"), "agent: add refused when management is disabled");
  assert(String((await exec(mcpRemove, { name: "mini" })).error).includes("disabled"), "agent: remove refused when management is disabled");
  assert((await exec(mcpCall, { server: "mini", tool: "echo", input: { text: "ro" } })).ok === true, "agent: still can call when management is disabled");
  delete process.env.WRONGFORGE_MCP_AGENT_MANAGE;

  assert((await exec(mcpRemove, { name: "mini" })).ok === true && agentReg.store.get("mini") === undefined, "agent: mcp_remove deletes it");
  assert((await exec(mcpRemove, { name: "mini" })).ok === false, "agent: removing twice -> ok:false");

  await Promise.all([reg.closeAll(), regHttp.closeAll(), agentReg.closeAll()]);
  console.log("MCP TESTS PASSED ✓ (config, redaction, ${VAR}, stdio, http, eager+lazy, allow/deny, timeout/cancel, pooling, failures, agent tools)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
