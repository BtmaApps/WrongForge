/**
 * Release updates: check GitHub for a newer WrongForge and — on demand —
 * replace the running binary with the release asset.
 *
 *   checkForUpdate()   what the serve banner + /v1/info show (never throws)
 *   selfUpdate()       `wrongforge update`: download → sha256 verify → swap
 *
 * Repo: WRONGFORGE_UPDATE_REPO (default ersinkoc/WrongForge). Checks are off
 * with WRONGFORGE_UPDATE_CHECK=0 (and in test mode, ANTHROPIC_BASE_URL set).
 * The swap renames the running executable aside — allowed even on Windows —
 * moves the verified download into place, and respawns with the same argv.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "./paths.js";

export const UPDATE_REPO = process.env.WRONGFORGE_UPDATE_REPO || "ersinkoc/WrongForge";

export interface UpdateAvailable {
  current: string;
  latest: string;
  url: string;
  notes: string;
}

export interface ReleaseInfo extends UpdateAvailable {
  asset?: { name: string; url: string; digest?: string; size: number };
}

/** Numeric-aware a.b.c comparison; true when `latest` > `current`. */
export function isNewer(latest: string, current: string): boolean {
  const num = (v: string): number[] =>
    v.replace(/^v/, "").split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const [a, b] = [num(latest), num(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/** The release asset name this platform downloads (`wrongforge-windows-x64.exe`). */
export function assetName(): string {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  return `wrongforge-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
}

/** Latest release from GitHub, or null (offline / disabled / no releases). */
export async function latestRelease(): Promise<ReleaseInfo | null> {
  if (process.env.WRONGFORGE_UPDATE_CHECK === "0") return null;
  if (process.env.ANTHROPIC_BASE_URL) return null; // test/proxy mode: no real network
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "wrongforge-update-check" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      assets?: Array<{ name?: string; browser_download_url?: string; digest?: string; size?: number }>;
    };
    const version = String(j.tag_name ?? "").replace(/^v/, "");
    if (!version) return null;
    const want = assetName();
    const asset = (j.assets ?? []).find((a) => a.name === want);
    return {
      current: VERSION,
      latest: version,
      url: j.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
      notes: String(j.body ?? ""),
      ...(asset?.browser_download_url
        ? { asset: { name: want, url: asset.browser_download_url, digest: asset.digest, size: asset.size ?? 0 } }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Last check result — what /v1/info surfaces to the dashboard. */
let lastCheck: UpdateAvailable | null = null;

export function lastUpdateCheck(): UpdateAvailable | null {
  return lastCheck;
}

/** Fires the check and remembers the result; null when already current. */
export async function checkForUpdate(): Promise<UpdateAvailable | null> {
  const rel = await latestRelease();
  lastCheck = rel && isNewer(rel.latest, rel.current) ? { current: rel.current, latest: rel.latest, url: rel.url, notes: rel.notes } : null;
  return lastCheck;
}

/** True when running as a compiled executable (self-update only then). */
function isCompiledBinary(): boolean {
  const exec = process.execPath.toLowerCase();
  return exec.includes("wrongforge") && !exec.includes("node_modules") && process.argv[0]?.toLowerCase().includes("wrongforge");
}

/**
 * `wrongforge update`: download the asset for this platform, verify its
 * sha256 digest against the release metadata, swap it in place of the
 * running executable and respawn. Returns a status line (or throws).
 */
export async function selfUpdate(): Promise<string> {
  const rel = await latestRelease();
  if (!rel) throw new Error(`cannot reach https://github.com/${UPDATE_REPO}/releases (or checks are disabled)`);
  if (!isNewer(rel.latest, rel.current)) return `already up to date (${VERSION})`;
  if (!rel.asset) throw new Error(`release ${rel.latest} has no asset "${assetName()}" for this platform`);
  if (!isCompiledBinary()) {
    throw new Error("self-update replaces the compiled binary — run it as `wrongforge update` from the executable, not from source");
  }
  const exe = process.execPath;
  const old = `${exe}.old`;
  const download = path.join(path.dirname(exe), `.wrongforge-update-${Date.now()}`);

  const res = await fetch(rel.asset.url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (rel.asset.digest) {
    const want = rel.asset.digest.replace(/^sha256:/, "");
    const got = crypto.createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`sha256 mismatch (wanted ${want.slice(0, 16)}…, got ${got.slice(0, 16)}…) — refusing to install`);
  }
  fs.writeFileSync(download, bytes, { mode: 0o755 });

  // Windows allows RENAMING a running exe (not deleting it): move the old
  // one aside, put the verified download in its place, respawn, exit.
  try {
    fs.rmSync(old, { force: true });
  } catch {
    /* a stale .old from an earlier update — ignore */
  }
  fs.renameSync(exe, old);
  try {
    fs.renameSync(download, exe);
  } catch (e) {
    fs.renameSync(old, exe); // put the old one back before giving up
    throw new Error(`could not move the new binary into place: ${(e as Error).message}`);
  }
  const args = process.argv.slice(1);
  console.log(`updated ${rel.current} → ${rel.latest}; restarting…`);
  if (args.length) spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
  process.exit(0);
}

/** Best-effort cleanup of a `.old` binary left by the previous update. */
export function cleanupOldBinary(): void {
  try {
    fs.rmSync(`${process.execPath}.old`, { force: true });
  } catch {
    /* not running as the binary / nothing to clean */
  }
}
