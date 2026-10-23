/**
 * Release updates: check GitHub for a newer WrongForge and — on demand —
 * replace the running binary with the release asset.
 *
 *   checkForUpdate()   what the serve banner + /v1/info show (never throws)
 *   prepareUpdate()    download + sha256 verify only — no filesystem/restart
 *   installUpdate()    swap the verified bytes in, respawn, exit — no network
 *   selfUpdate()       `wrongforge update`: prepareUpdate() then installUpdate()
 *
 * Repo: WRONGFORGE_UPDATE_REPO (default WrongStack/WrongForge). Checks are off
 * with WRONGFORGE_UPDATE_CHECK=0 (and in test mode, ANTHROPIC_BASE_URL set).
 * The swap renames the running executable aside — allowed even on Windows —
 * moves the verified download into place, and respawns with the same argv.
 *
 * Automatic use (src/server.ts, opt-in via WRONGFORGE_AUTO_UPDATE=1): the
 * server calls prepareUpdate() while still fully serving — a network failure
 * there touches nothing — and only calls installUpdate() (which tears down
 * the listening port first) once that succeeded. `respawn: false` is passed
 * when a crash-restart supervisor (src/supervisor.ts, WRONGFORGE_SUPERVISE=1)
 * owns this process, since the supervisor restarts it on exit either way; a
 * bare, unsupervised server keeps the CLI's respawn-itself behavior.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { VERSION } from "./paths.js";

export const UPDATE_REPO = process.env.WRONGFORGE_UPDATE_REPO || "WrongStack/WrongForge";

export interface UpdateAvailable {
  current: string;
  latest: string;
  url: string;
  notes: string;
}

export interface ReleaseInfo extends UpdateAvailable {
  asset?: { name: string; url: string; digest?: string; size: number };
}

/** Test seam: replaces the real GitHub call with `fn`; null restores it. */
let latestReleaseOverride: (() => Promise<ReleaseInfo | null>) | null = null;
export function setLatestReleaseForTest(fn: (() => Promise<ReleaseInfo | null>) | null): void {
  latestReleaseOverride = fn;
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
  if (latestReleaseOverride) return latestReleaseOverride();
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

/** Test seam: forces isCompiledBinary()'s return value; null restores it.
 *  Needed because it is always false under tsx/node — without this, nothing
 *  that gates on it (the auto-update timer, prepareUpdate()) can be driven
 *  through an integration test at all. */
let isCompiledBinaryOverride: boolean | null = null;
export function setIsCompiledBinaryForTest(v: boolean | null): void {
  isCompiledBinaryOverride = v;
}

/**
 * True when running as a compiled executable (self-update only then).
 *
 * Only checks `process.execPath` — the real on-disk path of the running
 * binary, confirmed reliable by compiling and running an actual `bun build
 * --compile` executable. An earlier version also required
 * `process.argv[0]?.includes("wrongforge")`, which made this ALWAYS false:
 * in a Bun single-file executable, `argv[0]` is the fixed string `"bun"`
 * (the runtime name), never the executable's own path — confirmed the same
 * way, and live against a real published release binary (GitHub issue #2).
 * That made every self-update path — the CLI's own `wrongforge update` and
 * the server's `WRONGFORGE_AUTO_UPDATE` — permanently refuse to run.
 */
export function isCompiledBinary(): boolean {
  if (isCompiledBinaryOverride !== null) return isCompiledBinaryOverride;
  const exec = process.execPath.toLowerCase();
  return exec.includes("wrongforge") && !exec.includes("node_modules");
}

export interface SelfUpdateOptions {
  /** Respawn with the same argv after the swap (default true — the CLI's
   *  behavior). A crash-restart supervisor (WRONGFORGE_SUPERVISE=1) passes
   *  false: it owns restarting this process on exit, so a self-respawn here
   *  would race it for the listening port. */
  respawn?: boolean;
}

export interface PreparedUpdate {
  rel: ReleaseInfo;
  bytes: Buffer;
}

/**
 * Network phase: check for a newer release, download its asset for this
 * platform, verify its sha256 digest. Touches nothing on disk and never
 * restarts anything — safe to call while the server is still fully up,
 * so a caller can confirm an update is real and verified BEFORE tearing
 * anything down for it. Returns null when already current.
 */
export async function prepareUpdate(): Promise<PreparedUpdate | null> {
  const rel = await latestRelease();
  if (!rel) throw new Error(`cannot reach https://github.com/${UPDATE_REPO}/releases (or checks are disabled)`);
  if (!isNewer(rel.latest, rel.current)) return null;
  if (!rel.asset) throw new Error(`release ${rel.latest} has no asset "${assetName()}" for this platform`);
  if (!isCompiledBinary()) {
    throw new Error("self-update replaces the compiled binary — run it as `wrongforge update` from the executable, not from source");
  }
  const res = await fetch(rel.asset.url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  // Fail closed: a release that publishes no sha256 digest for this asset (or an
  // unexpected digest algorithm) is NOT installed. Every WrongForge release
  // attaches SHA256SUMS.txt, so an absent digest means the metadata cannot be
  // trusted — installing unverified bytes would hand over the executable path.
  if (!rel.asset.digest) {
    throw new Error(`release ${rel.latest} publishes no sha256 digest for "${assetName()}" — refusing to install an unverified binary`);
  }
  const want = rel.asset.digest.replace(/^sha256:/, "");
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (got !== want) throw new Error(`sha256 mismatch (wanted ${want.slice(0, 16)}…, got ${got.slice(0, 16)}…) — refusing to install`);
  return { rel, bytes };
}

/**
 * Filesystem phase: swap a `prepareUpdate()`-verified download in place of
 * the running executable and (optionally) respawn. No network involved, so
 * once `prepared` is in hand this essentially cannot fail from the outside
 * world — the point of splitting it from `prepareUpdate()` is so a caller
 * that needs to tear something down first (closing a listening port) can do
 * so only after the network leg already succeeded. Exits the process on
 * success; never returns normally.
 */
export function installUpdate(prepared: PreparedUpdate, opts: SelfUpdateOptions = {}): void {
  const respawn = opts.respawn ?? true;
  const { rel, bytes } = prepared;
  const exe = process.execPath;
  // Owned by THIS process only. A fixed `<exe>.old` is shared by every instance
  // running from the same path, so cleaning it could delete another instance's
  // only copy of the previous binary.
  const old = asidePath(exe);
  const download = path.join(path.dirname(exe), `.wrongforge-update-${process.pid}-${Date.now()}`);
  fs.writeFileSync(download, bytes, { mode: 0o755 });

  // Windows allows RENAMING a running exe (not deleting it): move the old
  // one aside, put the verified download in its place, respawn, exit.
  try {
    fs.rmSync(old, { force: true });
  } catch {
    /* our own leftover from an earlier attempt in this process — ignore */
  }
  try {
    fs.renameSync(exe, old);
  } catch (e) {
    fs.rmSync(download, { force: true }); // nothing to install, drop the download
    throw new Error(`could not move the running binary aside: ${(e as Error).message}`);
  }
  try {
    fs.renameSync(download, exe);
  } catch (e) {
    // put the old one back before giving up — but if THAT rename also fails
    // (the same directory-level problem that broke the first one), its raw
    // exception must not silently replace the original diagnostic, and the
    // operator needs to be told exactly where their intact original binary
    // is sitting so they can rename it back by hand (F704).
    try {
      fs.renameSync(old, exe);
    } catch (rollbackError) {
      throw new Error(
        `could not move the new binary into place (${(e as Error).message}), and restoring the original binary ` +
          `also failed (${(rollbackError as Error).message}) — your previous working binary is still intact at: ${old}`,
      );
    }
    throw new Error(`could not move the new binary into place: ${(e as Error).message}`);
  }
  const args = process.argv.slice(1);
  if (respawn) {
    console.log(`updated ${rel.current} → ${rel.latest}; restarting…`);
    if (args.length) spawn(exe, args, { detached: true, stdio: "ignore" }).unref();
  } else {
    console.log(`updated ${rel.current} → ${rel.latest}; the supervisor will restart it`);
  }
  process.exit(0);
}

/**
 * `wrongforge update`: the combined CLI flow — prepare then install.
 * Returns a status line when already current (or throws); otherwise exits
 * the process on success, same as `installUpdate()`.
 */
export async function selfUpdate(opts: SelfUpdateOptions = {}): Promise<string> {
  const prepared = await prepareUpdate();
  if (!prepared) return `already up to date (${VERSION})`;
  installUpdate(prepared, opts);
  return ""; // unreachable — installUpdate() always exits the process
}

/** The rollback copy an update process owns while it swaps the binary. */
function asidePath(exe: string, pid: number = process.pid): string {
  return `${exe}.old.${pid}`;
}

/** True when `pid` still exists — a live pid means its update is in flight. */
function ownerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours to signal
  }
}

/**
 * Best-effort cleanup of rollback copies left by previous updates.
 * Only files no live process owns are removed: `<exe>.old.<pid>` whose owner is
 * still running is an in-flight update, not a leftover. The legacy fixed
 * `<exe>.old` can only predate this scheme, so it is always a leftover.
 */
export function cleanupOldBinary(): void {
  const dir = path.dirname(process.execPath);
  const base = path.basename(process.execPath);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagged = new RegExp(`^${escaped}\\.old\\.(\\d+)$`);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // not running as the binary / nothing to clean
  }
  for (const n of names) {
    const m = n === `${base}.old` ? null : tagged.exec(n);
    if (n !== `${base}.old` && !m) continue;
    if (m && ownerAlive(Number(m[1]))) continue;
    try {
      fs.rmSync(path.join(dir, n), { force: true });
    } catch {
      /* still locked by a running process — next start retries */
    }
  }
}
