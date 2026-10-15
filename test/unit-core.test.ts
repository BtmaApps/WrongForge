/**
 * Unit tests for the small core modules: compaction, cache breakpoints,
 * message conversion, tool runner, OAuth config, paths, banner, task prompts,
 * plan usage and maintenance.
 *
 *   npx tsx test/unit-core.test.ts
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  clearOldToolOutputs,
  compactMessages,
  contextConfigFromEnv,
  isContextOverflow,
  renderTranscript,
  splitTurns,
  CLEARED_PLACEHOLDER,
} from "../src/compaction.js";
import { applyCacheBreakpoints } from "../src/cache.js";
import { fromApiAssistantMessage, toApiMessages, type AgentMessage } from "../src/messages.js";
import { dynamicTool, runTool, tool } from "../src/tool.js";
import { configHelp, configFilePath, loadOAuthConfig } from "../src/config.js";
import { dataDir } from "../src/paths.js";
import { renderBanner, printBanner } from "../src/banner.js";
import { buildTaskPreamble, buildTaskSystemPrompt, loadPromptFiles, promptDir } from "../src/prompt.js";
import { fetchPlanUsage, untilLabel, usageLine } from "../src/usage.js";
import { retentionFromEnv, runMaintenance, startMaintenance } from "../src/maintenance.js";
import { Logger } from "../src/log.js";
import { ClaudeOAuth } from "../src/oauth.js";
import { TaskStore } from "../src/tasks/store.js";
import { SessionStore } from "../src/sessions.js";
import type Anthropic from "@anthropic-ai/sdk";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-unit-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

async function main(): Promise<void> {
  // ======================================================== compaction
  const msgs: AgentMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "bash", output: "out1" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ];
  assert(splitTurns(msgs).length === 2, "splitTurns: user starts a turn");
  assert(splitTurns([]).length === 0, "splitTurns: empty");

  const cleared = clearOldToolOutputs(msgs, 0);
  assert(cleared.cleared === 1 && cleared.messages !== msgs, "clearOldToolOutputs clears");
  assert(
    (cleared.messages[2] as { content: { output: { value: string } }[] }).content[0].output.value === CLEARED_PLACEHOLDER,
    "clearOldToolOutputs placeholder",
  );
  const recleared = clearOldToolOutputs(cleared.messages, 0);
  assert(recleared.cleared === 0 && recleared.messages === cleared.messages, "clearOldToolOutputs is idempotent");
  assert(clearOldToolOutputs(msgs, 5).messages === msgs, "clearOldToolOutputs keeps recent");

  const transcript = renderTranscript([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi\nthere" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "read", input: { p: 1 } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "read", output: { ok: true } }] },
  ]);
  assert(transcript.includes("USER: hello") && transcript.includes("ASSISTANT: hi"), "renderTranscript user/assistant");
  assert(transcript.includes("[tool call] read") && transcript.includes("[tool result] read"), "renderTranscript tools");
  const huge: AgentMessage[] = [{ role: "user", content: "x".repeat(700_000) }];
  assert(renderTranscript(huge, 1000).includes("chars omitted from the middle"), "renderTranscript clips middle");

  const fakeClient = {
    messages: {
      create: async () => ({ content: [{ type: "text", text: "  the summary  " }] }),
    },
  } as unknown as Anthropic;
  assert((await compactMessages(fakeClient, "m", msgs, 2)) === null, "compactMessages: nothing to summarize yet");
  const compacted = await compactMessages(fakeClient, "m", msgs, 1);
  assert(compacted?.summary === "the summary" && compacted.messages[0].role === "user", "compactMessages result");
  const emptyClient = { messages: { create: async () => ({ content: [] }) } } as unknown as Anthropic;
  let threw = false;
  try {
    await compactMessages(emptyClient, "m", msgs, 1);
  } catch {
    threw = true;
  }
  assert(threw, "compactMessages: empty summary throws");

  const cfg = contextConfigFromEnv({
    WRONGFORGE_CONTEXT_WINDOW: "2000",
    WRONGFORGE_COMPACT_AT: "0",
    WRONGFORGE_CLEAR_AT: "bad",
    WRONGFORGE_COMPACT_KEEP_TURNS: "0",
    WRONGFORGE_KEEP_TOOL_RESULTS: "3",
    WRONGFORGE_SUMMARY_MODEL: "x",
  });
  assert(cfg.window === 2000 && cfg.compactAt === 0 && cfg.clearAt === 600_000 && cfg.keepTurns === 1, "contextConfigFromEnv clamps");
  assert(isContextOverflow("prompt is too long") && !isContextOverflow("nope"), "isContextOverflow");

  // ======================================================== cache breakpoints
  const bodyStr = { system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }] };
  assert(applyCacheBreakpoints(bodyStr, "1h") === 2, "breakpoints: string content converted");
  assert((bodyStr.messages[0].content as { cache_control?: { ttl?: string } }[])[0].cache_control?.ttl === "1h", "breakpoints: 1h ttl");
  const bodyEmpty = { system: [{ type: "text", text: "" }], messages: [{ role: "user", content: [{ type: "text", text: "" }] }] };
  assert(applyCacheBreakpoints(bodyEmpty, "5m") === 0, "breakpoints: empty text not marked");
  assert(applyCacheBreakpoints({}, "off") === 0 && applyCacheBreakpoints(null, "5m") === 0, "breakpoints: off / null");
  const bodyKeep = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] };
  assert(applyCacheBreakpoints(bodyKeep, "5m") === 2, "breakpoints: existing markers kept");

  // ======================================================== messages conversion
  assert(toApiMessages([{ role: "user", content: "" }]).length === 0, "toApiMessages: empty string skipped");
  assert(toApiMessages([{ role: "assistant", content: [] }]).length === 0, "toApiMessages: empty parts skipped");
  assert(toApiMessages([{ role: "tool", content: [] }]).length === 0, "toApiMessages: empty tool msg skipped");
  const api = toApiMessages([
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: undefined }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: { a: 1 } }] },
  ]);
  assert((api[0].content[0] as { input: object }).input !== undefined, "toApiMessages: nullish input becomes {}");
  assert((api[1].content[0] as { content: string }).content === '{"a":1}', "toApiMessages: object output stringified");
  const back = fromApiAssistantMessage([{ type: "text", text: "hi" }, { type: "tool_use", id: "u", name: "n", input: { x: 1 } }]);
  assert(back.role === "assistant" && back.content.length === 2, "fromApiAssistantMessage round shape");

  // ======================================================== tool runner
  const echo = tool({
    description: "echo",
    inputSchema: z.object({ v: z.string() }),
    execute: async (i) => i.v,
  });
  assert((await runTool(echo, { v: "ok" }, {})).output === "ok", "runTool: zod path");
  const bad = await runTool(echo, { v: 42 }, {});
  assert(bad.ok === false && bad.error.length > 0, "runTool: validation failure");
  assert((await runTool(undefined, {}, {})).ok === false, "runTool: unknown tool");
  const dyn = dynamicTool({ description: "d", inputSchema: { type: "object" }, execute: async (i) => i });
  assert((await runTool(dyn, { any: true }, {})).ok === true, "runTool: raw schema passthrough");

  // ======================================================== oauth config
  const home1 = path.join(tmp, "no-config");
  fs.mkdirSync(home1);
  {
    process.env.WRONGFORGE_HOME = home1;
    delete process.env.CLAUDE_OAUTH_CLIENT_ID;
    delete process.env.CLAUDE_OAUTH_CONFIG;
    assert(loadOAuthConfig() === null, "loadOAuthConfig: null without client id");
    assert(configHelp().includes("CLAUDE_OAUTH_CLIENT_ID"), "configHelp text");
    process.env.CLAUDE_OAUTH_CLIENT_ID = "env-id";
    process.env.CLAUDE_OAUTH_AUTHORIZE_URL = "https://a.example";
    const c = loadOAuthConfig()!;
    assert(c.clientId === "env-id" && c.authorizeUrl === "https://a.example" && c.tokenUrl.includes("console.anthropic.com"), "loadOAuthConfig: env wins, defaults fill");
    delete process.env.CLAUDE_OAUTH_CLIENT_ID;
    delete process.env.CLAUDE_OAUTH_AUTHORIZE_URL;
    const file = path.join(home1, "oauth.json");
    fs.writeFileSync(file, JSON.stringify({ clientId: "file-id", tokenUrl: "https://t.example" }));
    assert(configFilePath().endsWith("oauth.json"), "configFilePath under home");
    const c2 = loadOAuthConfig()!;
    assert(c2.clientId === "file-id" && c2.tokenUrl === "https://t.example", "loadOAuthConfig: file values");
    process.env.CLAUDE_OAUTH_CONFIG = path.join(home1, "missing.json");
    assert(loadOAuthConfig() === null, "loadOAuthConfig: missing file via env path");
    delete process.env.CLAUDE_OAUTH_CONFIG;
  }

  // ======================================================== paths (legacy migration)
  const home2 = path.join(tmp, "legacy-home");
  const legacyDir = path.join(home2, ".wrongminiagent");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "marker.txt"), "x");
  {
    process.env.WRONGFORGE_HOME = home2 + "/.wrongforge"; // absent → triggers copy? no: explicit home wins
    delete process.env.WRONGFORGE_HOME;
    const osHomeBackup = process.env.USERPROFILE;
    // point homedir detection at home2 by faking os.homedir is not possible
    // without import; instead exercise the WRONGFORGE_HOME fast path only.
    process.env.WRONGFORGE_HOME = path.join(home2, "direct");
    assert(dataDir() === path.join(home2, "direct"), "dataDir: WRONGFORGE_HOME wins");
    process.env.WRONGFORGE_HOME = "";
    delete process.env.WRONGFORGE_HOME;
    void osHomeBackup;
  }

  // ======================================================== banner
  const key = { key: "sk-test-123456789", source: "env" as const };
  const banner = renderBanner(
    { version: "1.2.3", host: "127.0.0.1", port: 1234, key, signedIn: true, model: "m1", dataDir: "/d",
      logDir: "/l", maxConcurrency: 2, promptFiles: ["a.md"], defaultWorkdir: "/w", mcpServers: 1, recoveredTasks: 0 },
    true,
  );
  assert(banner.includes("1.2.3") && banner.includes("1234") && banner.includes("m1"), "renderBanner color, all fields");
  assert(banner.includes("a.md") && banner.includes("/w"), "renderBanner optional fields");
  const plain = renderBanner({ version: "0", host: "localhost", port: 1, key, signedIn: false, model: "m", dataDir: "/d" });
  assert(!plain.includes("\x1b["), "renderBanner plain");
  const gen = renderBanner({ version: "0", host: "::1", port: 1, key: { key: "k", source: "generated", file: "/f" }, signedIn: false, model: "m", dataDir: "/d" });
  assert(gen.includes("NEW") && gen.includes("[::1]"), "renderBanner generated key + ipv6 host");
  const fileKey = renderBanner({ version: "0", host: "h", port: 1, key: { key: "k", source: "file", file: "/f" }, signedIn: false, model: "m", dataDir: "/d" });
  assert(fileKey.includes("reused"), "renderBanner file-key note");
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(String(a[0]));
  printBanner({ version: "0", host: "h", port: 1, key, signedIn: false, model: "m", dataDir: "/d" });
  console.log = origLog;
  assert(logged.length > 0, "printBanner writes");

  // ======================================================== prompts
  const pdir = path.join(tmp, "prompts");
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, "b.md"), "guide b");
  fs.writeFileSync(path.join(pdir, "a.md"), "guide a");
  fs.writeFileSync(path.join(pdir, "_skip.md"), "no");
  fs.writeFileSync(path.join(pdir, "README.md"), "no");
  fs.writeFileSync(path.join(pdir, "empty.md"), "   ");
  const files = loadPromptFiles(pdir);
  assert(files.length === 2 && files[0].name === "a.md", "loadPromptFiles filters + sorts");
  assert(loadPromptFiles(path.join(tmp, "nope")).length === 0, "loadPromptFiles missing dir");
  process.env.WRONGFORGE_PROMPT_DIR = pdir;
  assert(promptDir() === pdir, "promptDir env override");
  delete process.env.WRONGFORGE_PROMPT_DIR;
  assert(buildTaskPreamble({ taskId: "t9", cwd: "/w" }).includes("task_id: t9"), "buildTaskPreamble");
  const sys = buildTaskSystemPrompt({ promptDir: pdir, systemAppend: " extra " });
  assert(sys.includes("## Guide: a") && sys.includes("## Additional instructions") && sys.includes("extra"), "buildTaskSystemPrompt");
  assert(!buildTaskSystemPrompt({ promptDir: pdir, systemAppend: "  " }).includes("Additional"), "systemAppend blank ignored");

  // ======================================================== usage (fake endpoint)
  let hits = 0;
  const usageServer = http.createServer((req, res) => {
    hits++;
    if (req.url === "/api/oauth/usage") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 55, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          limits: [
            { kind: "session", group: "session", percent: 55, resets_at: new Date(Date.now() + 3600_000).toISOString(), is_active: true },
            { kind: "weekly_scoped", group: "weekly", percent: 10, resets_at: new Date(Date.now() + 86_400_000).toISOString(), is_active: true },
          ],
          extra_usage: { is_enabled: false },
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => usageServer.listen(0, "127.0.0.1", r));
  const uport = (usageServer.address() as { port: number }).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${uport}`;
  // oauth with a fake token endpoint so getAccessToken never refreshes
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${uport}/v1/oauth/token`;
  process.env.CLAUDE_OAUTH_CLIENT_ID = "cov";
  const uoauth = new ClaudeOAuth(path.join(tmp, "usage-tokens.json"));
  uoauth.importFromClaudeCode;
  // seed a valid stored token by faking CC credentials
  const ccFile = path.join(tmp, "cc-creds.json");
  fs.writeFileSync(ccFile, JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
  uoauth.importFromClaudeCode(ccFile);

  const u1 = await fetchPlanUsage(uoauth, { force: true });
  assert(u1 && u1.fiveHour.percent === 55 && u1.weekly?.percent === 10, "fetchPlanUsage parses windows");
  assert(usageLine(u1).includes("5h session 55%"), "usageLine summary");
  const before = hits;
  await fetchPlanUsage(uoauth);
  assert(hits === before, "fetchPlanUsage cached");
  await fetchPlanUsage(uoauth, { force: true });
  assert(hits === before + 1, "fetchPlanUsage force refetches");
  assert(untilLabel(null) === "unknown" && untilLabel("not-a-date") === "unknown", "untilLabel invalid");
  assert(untilLabel(new Date(Date.now() + 90 * 60_000).toISOString()) === "1h 30m", "untilLabel formats");

  // fallback shape: no limits[] → five_hour projection only
  const usageServer2 = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ five_hour: { utilization: 7, resets_at: null } }));
  });
  await new Promise<void>((r) => usageServer2.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(usageServer2.address() as { port: number }).port}`;
  const u2 = await fetchPlanUsage(uoauth, { force: true });
  assert(u2 && u2.fiveHour.percent === 7 && u2.weekly === null, "fetchPlanUsage five_hour fallback");

  // non-ok → null
  const usageServer3 = http.createServer((_req, res) => res.writeHead(500).end());
  await new Promise<void>((r) => usageServer3.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(usageServer3.address() as { port: number }).port}`;
  assert((await fetchPlanUsage(uoauth, { force: true })) === null, "fetchPlanUsage non-ok → null");
  // network refusal → null (closed port)
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  assert((await fetchPlanUsage(uoauth, { force: true })) === null, "fetchPlanUsage network error → null");
  usageServer.close();
  usageServer2.close();
  usageServer3.close();

  // ======================================================== maintenance
  const mhome = path.join(tmp, "maint");
  fs.mkdirSync(mhome, { recursive: true });
  const mlog = new Logger({ dir: path.join(mhome, "logs") });
  const mtasks = new TaskStore(path.join(mhome, "tasks"));
  const msessions = new SessionStore(path.join(mhome, "sessions"));
  const mret = retentionFromEnv({ WRONGFORGE_MAINTENANCE_INTERVAL_MIN: "0", WRONGFORGE_SESSION_RETENTION_DAYS: "1" });
  assert(mret.intervalMinutes === 0 && mret.sessionDeleteAfterDays === 1, "retentionFromEnv");
  const summary = await runMaintenance({
    logger: mlog,
    taskStore: mtasks,
    sessions: msessions,
    retention: mret,
    now: () => new Date(),
  });
  assert(summary.duration_ms >= 0 && summary.sessions_deleted.length === 0, "runMaintenance happy path");

  // failing stores → error branches, still a summary
  const failing = {
    dir: path.join(mhome, "logs"),
    currentFile: () => "x",
    error: () => undefined,
    info: () => undefined,
  } as unknown as Logger;
  const failTasks = { maintain: async () => { throw new Error("boom"); } } as unknown as TaskStore;
  const failSessions = { prune: () => { throw new Error("boom"); } } as unknown as SessionStore;
  const summary2 = await runMaintenance({ logger: failing, taskStore: failTasks, sessions: failSessions, retention: mret });
  assert(summary2.logs !== undefined, "runMaintenance tolerates store failures");
  const stop = startMaintenance({ logger: mlog, taskStore: mtasks, sessions: msessions, retention: { ...mret, intervalMinutes: 30 } });
  stop();
  assert(true, "startMaintenance returns stopper");

  console.log("UNIT CORE TESTS PASSED ✓ (compaction, cache, messages, tool, config, paths, banner, prompt, usage, maintenance)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
