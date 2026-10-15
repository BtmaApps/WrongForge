/**
 * Unit test: JSONL logger (daily + size rotation, masking, truncation) and
 * log maintenance (gzip old files, delete very old files).
 *
 *   npx tsx test/log.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { Logger, maintainLogs, sanitize } from "../src/log.js";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-log-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const readLines = (f: string): any[] =>
  fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function main(): Promise<void> {
  // ---- basic record shape, masking, truncation, reserved keys ----
  let clock = new Date("2026-10-14T10:00:00.000Z");
  const dir = path.join(tmp, "logs");
  const log = new Logger({ dir, maxFileBytes: 600, maxFieldChars: 50, now: () => clock });

  log.info("task.started", {
    task_id: "t1",
    authorization: "Bearer SECRET",
    nested: { refresh_token: "RT", ok: 1 },
    big: "x".repeat(200),
    ts: "forged",
  });
  const f1 = path.join(dir, "forge-2026-10-14.jsonl");
  assert(fs.existsSync(f1), "daily file created");
  const rec = readLines(f1)[0];
  assert(rec.ts === "2026-10-14T10:00:00.000Z" && rec.level === "info" && rec.event === "task.started", "ts/level/event");
  assert(rec.task_id === "t1", "fields at top level");
  assert(rec.authorization === "[redacted]" && rec.nested.refresh_token === "[redacted]" && rec.nested.ok === 1, "secrets masked");
  assert(rec.big.includes("chars truncated") && rec.big.length < 120, "long string truncated");
  assert(rec._ts === "forged" && rec.ts !== "forged", "reserved key cannot overwrite ts");

  // debug is below the default level
  log.debug("noise");
  assert(readLines(f1).length === 1, "debug filtered");

  // cycles and errors must not throw
  const cyc: any = { a: 1 };
  cyc.self = cyc;
  log.warn("weird", { cyc, err: new Error("boom") });
  const weird = readLines(f1).at(-1);
  assert(weird.cyc.self === "[circular]" && weird.err.message === "boom", "cycle + Error handled");

  // ---- size rollover within a day ----
  for (let i = 0; i < 12; i++) log.info("fill", { i, pad: "y".repeat(40) });
  const sameDay = fs.readdirSync(dir).filter((n) => n.startsWith("forge-2026-10-14"));
  assert(sameDay.length >= 2 && sameDay.includes("forge-2026-10-14.1.jsonl"), "size rollover creates .1.jsonl");
  for (const n of sameDay) {
    assert(fs.statSync(path.join(dir, n)).size <= 600 + 200, `rolled file stays near the size cap (${n})`);
  }
  const total = sameDay.reduce((a, n) => a + readLines(path.join(dir, n)).length, 0);
  assert(total === 1 + 1 + 12, "no record lost across rollover");

  // ---- next day -> new file ----
  clock = new Date("2026-10-15T00:00:05.000Z");
  log.info("new-day");
  assert(fs.existsSync(path.join(dir, "forge-2026-10-15.jsonl")), "new UTC day -> new file");
  assert(log.currentFile().endsWith("forge-2026-10-15.jsonl"), "currentFile()");

  // ---- maintenance: compress after 1 day, delete after 30 ----
  const old1 = path.join(dir, "forge-2026-09-01.jsonl"); // 44 days old -> deleted
  const old2 = path.join(dir, "forge-2026-09-20.jsonl.gz"); // 25 days old gz -> kept
  const old3 = path.join(dir, "forge-2026-10-10.jsonl"); // 5 days old -> compressed
  const old4 = path.join(dir, "forge-2026-08-01.jsonl.gz"); // 75 days -> deleted
  fs.writeFileSync(old1, '{"a":1}\n');
  fs.writeFileSync(old2, "gz");
  fs.writeFileSync(old3, '{"keep":"me"}\n'.repeat(50));
  fs.writeFileSync(old4, "gz");
  const setAge = (f: string, days: number) => {
    const t = new Date(clock.getTime() - days * 86_400_000);
    fs.utimesSync(f, t, t);
  };
  setAge(old1, 44); setAge(old2, 25); setAge(old3, 5); setAge(old4, 75);
  // yesterday's files (the 14th) are older than 1 day relative to `clock`? make them 2 days old
  for (const n of sameDay) setAge(path.join(dir, n), 1.2);

  const res = await maintainLogs({
    dir,
    compressAfterDays: 1,
    deleteAfterDays: 30,
    skip: [log.currentFile()],
    now: () => clock,
  });

  assert(!fs.existsSync(old1) && !fs.existsSync(old4), "files older than retention deleted");
  assert(fs.existsSync(old2), "gz inside retention kept");
  assert(!fs.existsSync(old3) && fs.existsSync(old3 + ".gz"), "old jsonl compressed");
  const unzipped = gunzipSync(fs.readFileSync(old3 + ".gz")).toString("utf8");
  assert(unzipped === '{"keep":"me"}\n'.repeat(50), "gzip round-trips exactly");
  const gzAge = (clock.getTime() - fs.statSync(old3 + ".gz").mtimeMs) / 86_400_000;
  assert(Math.abs(gzAge - 5) < 0.01, "gz keeps the original age (retention clock not reset)");
  assert(fs.existsSync(log.currentFile()), "active file untouched");
  assert(sameDay.every((n) => fs.existsSync(path.join(dir, n + ".gz"))), "yesterday's rolled files compressed");
  assert(res.errors.length === 0, "no errors");
  assert(res.deleted.length === 2 && res.compressed.length >= 3, "result lists what happened");

  // idempotent
  const again = await maintainLogs({ dir, compressAfterDays: 1, deleteAfterDays: 30, skip: [log.currentFile()], now: () => clock });
  assert(again.compressed.length === 0 && again.deleted.length === 0, "second run is a no-op");

  // 0 disables both
  fs.writeFileSync(path.join(dir, "forge-2000-01-01.jsonl"), "{}\n");
  setAge(path.join(dir, "forge-2000-01-01.jsonl"), 9000);
  const off = await maintainLogs({ dir, compressAfterDays: 0, deleteAfterDays: 0, now: () => clock });
  assert(off.compressed.length === 0 && off.deleted.length === 0, "0 disables compress and delete");

  // missing dir is fine
  const none = await maintainLogs({ dir: path.join(tmp, "nope"), compressAfterDays: 1, deleteAfterDays: 1 });
  assert(none.errors.length === 0, "missing dir tolerated");

  // sanitize direct
  assert(sanitize({ password: "p" }, 10) !== null && (sanitize({ password: "p" }, 10) as any).password === "[redacted]", "sanitize masks");

  console.log("LOG TESTS PASSED ✓ (shape, masking, truncation, rollover, gzip, retention)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
