/**
 * Release update helpers: version comparison, asset naming, the GitHub
 * fetch (via the test seam, never the real network), compiled-binary
 * detection, prepareUpdate()'s gating, and rollback-copy cleanup.
 *
 *   npx tsx test/update.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assetName,
  checkForUpdate,
  cleanupOldBinary,
  isCompiledBinary,
  isNewer,
  latestRelease,
  prepareUpdate,
  setLatestReleaseForTest,
  type ReleaseInfo,
} from "../src/update.js";
import { VERSION } from "../src/paths.js";

function check(cond: unknown, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

// --- isNewer(): numeric-aware a.b.c comparison ---
check(isNewer("1.2.0", "1.1.9"), "minor bump is newer");
check(isNewer("2.0.0", "1.9.9"), "major bump is newer");
check(isNewer("1.1.10", "1.1.9"), "numeric (not lexicographic) patch comparison");
check(!isNewer("1.1.9", "1.1.9"), "equal versions are not newer");
check(!isNewer("1.1.0", "1.2.0"), "older is not newer");
check(isNewer("v1.2.0", "1.1.0"), "a leading v is stripped");
check(isNewer("1.2.0-beta.2", "1.2.0-beta.1"), "prerelease segments compare numerically too");

// --- assetName(): matches this platform/arch ---
{
  const name = assetName();
  const wantOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const wantExt = process.platform === "win32" ? ".exe" : "";
  check(name === `wrongforge-${wantOs}-${process.arch}${wantExt}`, "assetName matches this platform/arch");
}

// --- isCompiledBinary(): false under tsx/node (tests never run as the release exe) ---
check(!isCompiledBinary(), "tsx/node is never the compiled binary");

// --- latestRelease(): the disabled paths never touch the network ---
async function testDisabledPaths(): Promise<void> {
  const savedCheck = process.env.WRONGFORGE_UPDATE_CHECK;
  const savedBase = process.env.ANTHROPIC_BASE_URL;
  try {
    process.env.WRONGFORGE_UPDATE_CHECK = "0";
    delete process.env.ANTHROPIC_BASE_URL;
    check((await latestRelease()) === null, "WRONGFORGE_UPDATE_CHECK=0 short-circuits to null");

    delete process.env.WRONGFORGE_UPDATE_CHECK;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
    check((await latestRelease()) === null, "a set ANTHROPIC_BASE_URL (test/proxy mode) short-circuits to null");
  } finally {
    if (savedCheck === undefined) delete process.env.WRONGFORGE_UPDATE_CHECK;
    else process.env.WRONGFORGE_UPDATE_CHECK = savedCheck;
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBase;
  }
}

// --- the test seam: setLatestReleaseForTest() replaces the GitHub call ---
async function testSeamAndCheckForUpdate(): Promise<void> {
  const newer: ReleaseInfo = {
    current: VERSION,
    latest: "999.0.0",
    url: "https://example.invalid/releases/999.0.0",
    notes: "fake release for tests",
    asset: { name: assetName(), url: "https://example.invalid/download", digest: `sha256:${"0".repeat(64)}`, size: 123 },
  };
  try {
    setLatestReleaseForTest(async () => newer);
    check((await latestRelease()) === newer, "the override replaces the real GitHub call");

    const u = await checkForUpdate();
    check(u !== null && u.latest === "999.0.0" && u.current === VERSION, "checkForUpdate surfaces the override result when it is newer");

    // same-or-older "release" -> nothing to report
    setLatestReleaseForTest(async () => ({ ...newer, latest: VERSION }));
    check((await checkForUpdate()) === null, "checkForUpdate reports nothing when already current");

    // prepareUpdate(): a newer release is found, but isCompiledBinary() is
    // false under tsx — it must refuse rather than attempt a download
    setLatestReleaseForTest(async () => newer);
    let threw = false;
    try {
      await prepareUpdate();
    } catch (e) {
      threw = /compiled binary/.test((e as Error).message);
    }
    check(threw, "prepareUpdate() refuses to run outside the compiled binary");

    // prepareUpdate(): null when already current, before the compiled-binary
    // gate is even reached — no network call, no error
    setLatestReleaseForTest(async () => ({ ...newer, latest: VERSION }));
    check((await prepareUpdate()) === null, "prepareUpdate() is a no-op when already current");
  } finally {
    setLatestReleaseForTest(null);
  }
}

// --- cleanupOldBinary(): removes rollback copies with no live owner only ---
async function testCleanupOldBinary(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-update-"));
  const savedExecPath = process.execPath;
  const exe = path.join(dir, process.platform === "win32" ? "wrongforge.exe" : "wrongforge");
  fs.writeFileSync(exe, "fake binary");
  const deadPid = 999999; // astronomically unlikely to be a live pid
  const legacy = `${exe}.old`;
  const liveOwned = `${exe}.old.${process.pid}`; // this process is alive
  const deadOwned = `${exe}.old.${deadPid}`;
  fs.writeFileSync(legacy, "stale legacy copy");
  fs.writeFileSync(liveOwned, "in-flight update");
  fs.writeFileSync(deadOwned, "leftover from a crashed update");
  try {
    Object.defineProperty(process, "execPath", { value: exe, configurable: true });
    cleanupOldBinary();
    check(!fs.existsSync(legacy), "the legacy fixed .old copy is always removed");
    check(fs.existsSync(liveOwned), "a copy owned by a live pid is left alone (its update is in flight)");
    check(!fs.existsSync(deadOwned), "a copy owned by a dead pid is removed");
  } finally {
    Object.defineProperty(process, "execPath", { value: savedExecPath, configurable: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testDisabledPaths();
  await testSeamAndCheckForUpdate();
  await testCleanupOldBinary();
  console.log("ALL TESTS PASSED ✓ (isNewer, assetName, isCompiledBinary, latestRelease disabled paths, test seam, checkForUpdate, prepareUpdate gating, cleanupOldBinary)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
