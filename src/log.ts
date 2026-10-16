/**
 * JSONL logging + log maintenance.
 *
 *   <logs dir>/forge-2026-10-15.jsonl      active file of that (UTC) day
 *   <logs dir>/forge-2026-10-15.1.jsonl    size rollover (same day, > maxFileBytes)
 *   <logs dir>/forge-2026-10-14.jsonl.gz   compressed by `maintainLogs`
 *
 * One JSON object per line: { ts, level, event, ...fields }.
 *
 * Guarantees
 *  - Logging never throws and never blocks the caller on a failure.
 *  - Secrets are masked (keys like authorization / token / secret / signature …).
 *  - Very long strings are truncated (`…[N chars truncated]`) so one huge tool
 *    output cannot blow up a log file.
 *  - `maintainLogs` gzips files older than N days and deletes files older than M days.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DAY_MS = 86_400_000;
const RESERVED = new Set(["ts", "level", "event"]);
const SECRET_KEY = /^(authorization|proxy-authorization|access_?token|refresh_?token|id_?token|token|secret|password|passwd|api_?key|x-api-key|signature|cookie|set-cookie|code_?verifier)$/i;

export interface LoggerOptions {
  /** Directory for the log files (created if missing). */
  dir: string;
  /** File name prefix (default `forge`). */
  prefix?: string;
  /** Start a new file when the active one would exceed this size (default 50 MB). */
  maxFileBytes?: number;
  /** Strings longer than this are truncated in the log (default 20 000 chars). */
  maxFieldChars?: number;
  /** Minimum level that is written (default `info`). */
  level?: LogLevel;
  /** Also print each line to stderr. */
  stderr?: boolean;
  /** Clock override (tests). */
  now?: () => Date;
}

export class Logger {
  readonly dir: string;
  private readonly prefix: string;
  private readonly maxFileBytes: number;
  private readonly maxFieldChars: number;
  private readonly minRank: number;
  private readonly stderr: boolean;
  private readonly now: () => Date;

  private day = "";
  private index = 0;
  private size = 0;

  constructor(opts: LoggerOptions) {
    this.dir = opts.dir;
    this.prefix = opts.prefix ?? "forge";
    this.maxFileBytes = opts.maxFileBytes ?? 50 * 1024 * 1024;
    this.maxFieldChars = opts.maxFieldChars ?? 20_000;
    this.minRank = LEVEL_RANK[opts.level ?? "info"];
    this.stderr = opts.stderr ?? false;
    this.now = opts.now ?? (() => new Date());
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* logging must not break startup */
    }
  }

  /** Path of the file the next record will go to (maintenance must not touch it). */
  currentFile(): string {
    return path.join(this.dir, this.fileName(this.day || utcDay(this.now()), this.index));
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.log("debug", event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.log("info", event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.log("warn", event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.log("error", event, fields); }

  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    try {
      const date = this.now();
      const rec: Record<string, unknown> = { ts: date.toISOString(), level, event };
      const clean = sanitize(fields, this.maxFieldChars) as Record<string, unknown>;
      for (const [k, v] of Object.entries(clean)) rec[RESERVED.has(k) ? `_${k}` : k] = v;
      const line = JSON.stringify(rec) + "\n";
      const bytes = Buffer.byteLength(line);

      this.select(utcDay(date), bytes);
      fs.appendFileSync(path.join(this.dir, this.fileName(this.day, this.index)), line);
      this.size += bytes;
      if (this.stderr) process.stderr.write(line);
    } catch {
      /* never throw from logging */
    }
  }

  private fileName(day: string, idx: number): string {
    return idx === 0 ? `${this.prefix}-${day}.jsonl` : `${this.prefix}-${day}.${idx}.jsonl`;
  }

  /** Picks the target file: new day -> index 0; full file -> next index. */
  private select(day: string, incoming: number): void {
    if (day !== this.day) {
      this.day = day;
      this.index = 0;
      this.size = fileSize(path.join(this.dir, this.fileName(day, 0)));
    }
    while (this.size > 0 && this.size + incoming > this.maxFileBytes) {
      this.index++;
      this.size = fileSize(path.join(this.dir, this.fileName(this.day, this.index)));
    }
  }
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Deep copy that masks secrets, truncates long strings and survives cycles. */
export function sanitize(value: unknown, maxChars: number, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return value.length > maxChars
        ? `${value.slice(0, maxChars)}…[${value.length - maxChars} chars truncated]`
        : value;
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return `[${typeof value}]`;
  }
  const obj = value as object;
  if (obj instanceof Error) return { name: obj.name, message: sanitize(obj.message, maxChars) };
  if (seen.has(obj)) return "[circular]";
  if (depth >= 8) return "[max depth]";
  seen.add(obj);
  if (Array.isArray(obj)) return obj.map((v) => sanitize(v, maxChars, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitize(v, maxChars, depth + 1, seen);
  }
  return out;
}

// ---------------------------------------------------------------- maintenance

export interface MaintainOptions {
  dir: string;
  /** Gzip `*.jsonl` files not modified for this many days. 0 disables compression. */
  compressAfterDays: number;
  /** Delete `*.jsonl` / `*.jsonl.gz` files not modified for this many days. 0 disables deletion. */
  deleteAfterDays: number;
  /** Absolute paths that must not be touched (e.g. the logger's active file). */
  skip?: Iterable<string>;
  /** Clock override (tests). */
  now?: () => Date;
}

export interface MaintainResult {
  compressed: string[];
  deleted: string[];
  errors: { file: string; error: string }[];
}

/** Compresses `src` to `src.gz` (atomically) and removes the original. */
export async function gzipFile(src: string): Promise<string> {
  const dest = `${src}.gz`;
  const tmp = `${dest}.tmp`;
  try {
    const st = fs.statSync(src);
    await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    // keep the original age so the retention clock does not restart at compression time
    fs.utimesSync(dest, st.atime, st.mtime);
    fs.rmSync(src);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return dest;
}

/**
 * Housekeeping for a directory of JSONL logs: gzip old files, delete very old
 * ones. Safe to run repeatedly and while the server is writing (the active
 * file is skipped). Age is measured by the file's modification time.
 */
export async function maintainLogs(opts: MaintainOptions): Promise<MaintainResult> {
  const result: MaintainResult = { compressed: [], deleted: [], errors: [] };
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const skip = new Set([...(opts.skip ?? [])].map((p) => path.resolve(p)));

  let names: string[];
  try {
    names = fs.readdirSync(opts.dir);
  } catch (e) {
    // A directory that cannot be listed is NOT "nothing to maintain": answering
    // clean would hide a dead housekeeping step (nothing compresses, nothing is
    // ever deleted) behind a zero-error summary. A missing directory is benign.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      result.errors.push({ file: opts.dir, error: (e as Error).message });
    }
    return result;
  }

  for (const name of names) {
    if (!/\.jsonl(\.gz)?$/.test(name)) continue;
    const file = path.join(opts.dir, name);
    if (skip.has(path.resolve(file))) continue;
    try {
      const age = nowMs - fs.statSync(file).mtimeMs;
      if (opts.deleteAfterDays > 0 && age > opts.deleteAfterDays * DAY_MS) {
        fs.rmSync(file);
        result.deleted.push(file);
      } else if (opts.compressAfterDays > 0 && name.endsWith(".jsonl") && age > opts.compressAfterDays * DAY_MS) {
        result.compressed.push(await gzipFile(file));
      }
    } catch (e) {
      result.errors.push({ file, error: (e as Error).message });
    }
  }
  return result;
}
