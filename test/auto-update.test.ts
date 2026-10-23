/**
 * Automatic self-update (WRONGFORGE_AUTO_UPDATE=1): end-to-end against the
 * real startEnvServer() in a child process — a running task must suppress
 * the idle poller, an idle server must fire it. See
 * test/helpers/auto-update-runner.ts for what the child actually does.
 *
 *   npx tsx test/auto-update.test.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Fake } from "./helpers/harness.js";

function check(cond: unknown, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const TSX = process.execPath;
const TSX_ARGS = [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")];

async function main(): Promise<void> {
  const fake = new Fake();
  await fake.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wf-auto-update-"));
  const workdir = fs.mkdtempSync(path.join(home, "wd-"));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    WRONGFORGE_HOME: home,
    AGENT_API_KEY: "wf_test_agent_key_0123456789",
    HOST: "127.0.0.1",
    PORT: "0",
    CLAUDE_TOKEN_STORE: path.join(home, "tokens.json"),
    ANTHROPIC_TOKEN_URL: `${fake.base}/v1/oauth/token`,
    CLAUDE_OAUTH_CLIENT_ID: "test-client-id",
    ANTHROPIC_API_KEY: "test-upstream-key", // bypasses OAuth entirely (see provider.ts)
    ANTHROPIC_BASE_URL: `${fake.base}/v1`,
    WRONGFORGE_AUTO_UPDATE: "1",
    WRONGFORGE_AUTO_UPDATE_POLL_MS: "50",
    WRONGFORGE_UPDATE_CHECK: "1", // the test seam overrides the real call anyway
    WF_ENTRY_WORKDIR: workdir,
  };

  const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(TSX, [...TSX_ARGS, path.join(ROOT, "test/helpers/auto-update-runner.ts")], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const killer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill();
    }, 30_000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ code: c, out, err: stderr });
    });
  });

  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });

  check(out.includes("AUTO-UPDATE-OK"), `the runner reported success (exit ${code})\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);

  // F963: the idle poller must never start a second prepareUpdate() while a
  // previous one is still in flight (a slow release download can easily
  // outlast one poll interval) — see test/helpers/auto-update-reentrancy-runner.ts.
  // Fresh fake OAuth server + home: the ones above are already closed.
  const reentrancyFake = new Fake();
  await reentrancyFake.start();
  const reentrancyHome = fs.mkdtempSync(path.join(os.tmpdir(), "wf-f963-"));
  const reentrancyEnv: NodeJS.ProcessEnv = {
    ...env,
    WRONGFORGE_HOME: reentrancyHome,
    CLAUDE_TOKEN_STORE: path.join(reentrancyHome, "tokens.json"),
    ANTHROPIC_TOKEN_URL: `${reentrancyFake.base}/v1/oauth/token`,
    ANTHROPIC_BASE_URL: `${reentrancyFake.base}/v1`,
    F963_DELAY_MS: "400",
    WRONGFORGE_AUTO_UPDATE_POLL_MS: "50",
  };
  const reentrancy = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(TSX, [...TSX_ARGS, path.join(ROOT, "test/helpers/auto-update-reentrancy-runner.ts")], {
      env: reentrancyEnv, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const killer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill();
    }, 20_000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ code: c, out, err: stderr });
    });
  });
  await reentrancyFake.close();
  fs.rmSync(reentrancyHome, { recursive: true, force: true });
  const line = reentrancy.out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  check(!!line, `reentrancy runner reported a result (exit ${reentrancy.code})\n--- stdout ---\n${reentrancy.out}\n--- stderr ---\n${reentrancy.err}`);
  const result = JSON.parse(line!) as { totalCalls: number; maxConcurrent: number };
  check(result.maxConcurrent === 1, `F963: never more than one in-flight prepareUpdate() call (got maxConcurrent=${result.maxConcurrent} across ${result.totalCalls} ticks)`);

  console.log("ALL TESTS PASSED ✓ (auto-update: suppressed while a task is in flight, triggers once idle, single-flight under a slow download)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
