/**
 * Crash-restart supervisor: spawns a fake child, restarts it on exit with
 * growing backoff, and forwards its own SIGINT to the child without
 * restarting afterward (an intentional shutdown, not a crash).
 *
 *   npx tsx test/supervisor.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSupervisor } from "../src/supervisor.js";

function check(cond: unknown, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-supervisor-"));
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeScript(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body);
  return file;
}

// --- crash-restart + growing backoff ---
async function testCrashRestartBackoff(): Promise<void> {
  const crasher = writeScript("crasher.js", "process.exit(1);\n");
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    // stop the supervisor after its 3rd restart wait so the test terminates.
    // process.emit (not process.kill) fires the SIGINT listener directly —
    // on Windows, a real self-signal terminates the process unconditionally
    // before any handler runs, which would just kill the test runner.
    if (waits.length >= 3) process.emit("SIGINT");
    return new Promise((r) => setTimeout(r, 20)); // real tick so the signal lands
  };
  await runSupervisor([crasher], { command: process.execPath, sleep });
  check(waits.length >= 3, "the supervisor restarted the crashing child multiple times");
  check(waits[0] === 1000, "the first backoff is the initial 1s");
  check(waits[1] === 2000, "the second backoff doubles");
  check(waits[2] === 4000, "the third backoff doubles again");
}

// --- SIGINT is forwarded to the child; the supervisor stops without restarting ---
async function testSignalForwardingStopsWithoutRestart(): Promise<void> {
  const longRunner = writeScript("long-runner.js", "setInterval(() => {}, 1000);\n");
  let sleepCalls = 0;
  const sleep = (): Promise<void> => {
    sleepCalls++;
    return Promise.resolve();
  };
  const run = runSupervisor([longRunner], { command: process.execPath, sleep });
  await new Promise((r) => setTimeout(r, 500)); // let the child actually spawn
  process.emit("SIGINT"); // see the note above: not process.kill(process.pid, …)
  await run; // must resolve — an intentional shutdown must not hang
  check(sleepCalls === 0, "no restart/backoff wait happens on an intentional shutdown");
}

async function main(): Promise<void> {
  await testCrashRestartBackoff();
  await testSignalForwardingStopsWithoutRestart();
  console.log("ALL TESTS PASSED ✓ (crash-restart, growing backoff, SIGINT forwarding without restart)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
