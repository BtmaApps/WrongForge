/**
 * Housekeeping: compress and delete old logs, task event logs and sessions.
 *
 *   logs      *.jsonl  -> gzip after N days      -> delete after M days
 *   tasks     events.jsonl of FINISHED tasks -> gzip after N days -> whole task deleted after M days
 *   sessions  deleted after M days without activity (0 = keep forever; archives go with them)
 *
 * Runs at startup and then periodically inside the server, or once by hand:
 * `npm run maintain` (safe while the server is running: live tasks, busy
 * sessions and the active log file are never touched).
 *
 * Environment (days; 0 disables that step):
 *   WRONGFORGE_LOG_COMPRESS_AFTER_DAYS   default 1
 *   WRONGFORGE_LOG_RETENTION_DAYS        default 30
 *   WRONGFORGE_TASK_COMPRESS_AFTER_DAYS  default 3
 *   WRONGFORGE_TASK_RETENTION_DAYS       default 90
 *   WRONGFORGE_SESSION_RETENTION_DAYS    default 0 (keep)
 *   WRONGFORGE_MAINTENANCE_INTERVAL_MIN  default 60 (0 = only at startup)
 */

import type { Logger } from "./log.js";
import { maintainLogs, type MaintainResult } from "./log.js";
import type { SessionStore } from "./sessions.js";
import type { TaskStore, TaskMaintainResult } from "./tasks/store.js";

export interface Retention {
  logCompressAfterDays: number;
  logDeleteAfterDays: number;
  taskCompressAfterDays: number;
  taskDeleteAfterDays: number;
  sessionDeleteAfterDays: number;
  intervalMinutes: number;
}

const days = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): Retention {
  return {
    logCompressAfterDays: days(env.WRONGFORGE_LOG_COMPRESS_AFTER_DAYS, 1),
    logDeleteAfterDays: days(env.WRONGFORGE_LOG_RETENTION_DAYS, 30),
    taskCompressAfterDays: days(env.WRONGFORGE_TASK_COMPRESS_AFTER_DAYS, 3),
    taskDeleteAfterDays: days(env.WRONGFORGE_TASK_RETENTION_DAYS, 90),
    sessionDeleteAfterDays: days(env.WRONGFORGE_SESSION_RETENTION_DAYS, 0),
    intervalMinutes: days(env.WRONGFORGE_MAINTENANCE_INTERVAL_MIN, 60),
  };
}

export interface MaintenanceDeps {
  logger: Logger;
  taskStore: TaskStore;
  sessions: SessionStore;
  retention: Retention;
  /** Sessions with a queued/running task — never pruned. */
  busySessions?: () => Set<string>;
  now?: () => Date;
}

export interface MaintenanceSummary {
  at: string;
  duration_ms: number;
  logs: MaintainResult;
  tasks: TaskMaintainResult;
  sessions_deleted: string[];
}

/** One housekeeping pass. Never throws; failures are reported inside the summary / log. */
export async function runMaintenance(d: MaintenanceDeps): Promise<MaintenanceSummary> {
  const started = Date.now();
  const r = d.retention;
  const empty = { compressed: [], deleted: [], errors: [] };

  let logs: MaintainResult = empty;
  let tasks: TaskMaintainResult = empty;
  let sessionsDeleted: string[] = [];

  try {
    logs = await maintainLogs({
      dir: d.logger.dir,
      compressAfterDays: r.logCompressAfterDays,
      deleteAfterDays: r.logDeleteAfterDays,
      skip: [d.logger.currentFile()],
      now: d.now,
    });
  } catch (e) {
    d.logger.error("maintenance.logs_failed", { error: e });
  }
  try {
    tasks = await d.taskStore.maintain({
      compressAfterDays: r.taskCompressAfterDays,
      deleteAfterDays: r.taskDeleteAfterDays,
      now: d.now,
    });
  } catch (e) {
    d.logger.error("maintenance.tasks_failed", { error: e });
  }
  try {
    sessionsDeleted = d.sessions.prune(r.sessionDeleteAfterDays, d.now?.() ?? new Date(), d.busySessions?.() ?? new Set());
  } catch (e) {
    d.logger.error("maintenance.sessions_failed", { error: e });
  }

  const summary: MaintenanceSummary = {
    at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    logs,
    tasks,
    sessions_deleted: sessionsDeleted,
  };
  d.logger.info("maintenance.done", {
    duration_ms: summary.duration_ms,
    logs_compressed: logs.compressed.length,
    logs_deleted: logs.deleted.length,
    tasks_compressed: tasks.compressed.length,
    tasks_deleted: tasks.deleted.length,
    sessions_deleted: sessionsDeleted.length,
    errors: [...logs.errors, ...tasks.errors],
  });
  return summary;
}

/**
 * Runs maintenance shortly after startup and then every `intervalMinutes`.
 * Returns a stop function. Timers are unref'ed (they never keep the process alive).
 */
export function startMaintenance(d: MaintenanceDeps): () => void {
  const timers: NodeJS.Timeout[] = [];
  const first = setTimeout(() => void runMaintenance(d), 5_000);
  first.unref();
  timers.push(first);
  if (d.retention.intervalMinutes > 0) {
    const t = setInterval(() => void runMaintenance(d), d.retention.intervalMinutes * 60_000);
    t.unref();
    timers.push(t);
  }
  return () => timers.forEach((t) => clearTimeout(t));
}
