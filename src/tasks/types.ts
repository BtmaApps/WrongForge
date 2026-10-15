/**
 * Task protocol types — the contract between an orchestrator (WrongStack)
 * and WrongForge. Keep docs/TASKS-API.md in sync with this file.
 */

import type { TokenUsage } from "../agent.js";
import type { Todo } from "../tools/todo-state.js";
import type { CacheMode } from "../cache.js";

/** `queued` and `running` are live; the other four are terminal. */
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const isTerminal = (s: TaskStatus): boolean => TERMINAL_STATUSES.has(s);

/** Machine-readable failure reasons (`error.code`). */
export type TaskErrorCode =
  | "agent_error" //       the model/provider call or the loop failed
  | "max_steps" //         step limit reached before the model finished
  | "max_tokens" //        output limit hit (finish_reason "length")
  | "server_restarted" //  the server stopped while the task was queued/running
  | "internal_error"; //   bug / unexpected exception

export interface TaskError {
  code: TaskErrorCode;
  message: string;
}

export interface TaskResult {
  /** Final assistant text (all steps concatenated). */
  text: string;
  /** AI SDK finish reason: stop | length | tool-calls | … */
  finish_reason: string;
  steps: number;
  tool_calls: number;
  usage: TokenUsage;
  duration_ms: number;
}

export interface TaskProgress {
  /** Highest event seq written so far. */
  last_event_seq: number;
  steps: number;
  tool_calls: number;
  /** Tool currently executing, if any. */
  current_tool?: { id: string; name: string; started_at: string };
  /** Last `report_progress` message. */
  last_report?: { message: string; percent?: number; phase?: string; at: string };
  /** Current todo list. */
  todos?: Todo[];
  /** Last time anything happened (event or heartbeat-free activity). */
  last_activity_at: string;
}

export interface CallbackSpec {
  /** Where WrongForge POSTs events. */
  url: string;
  /**
   * Which event types to send. Patterns: exact (`task.completed`), prefix
   * wildcard (`task.*`, `tool.*`) or `*`. Default: everything except `agent.text`.
   */
  events?: string[];
}

export interface CallbackStats {
  delivered: number;
  failed: number;
  last_error?: string;
}

/** The persisted + API-visible task document (`tasks/<id>/task.json`). */
export interface TaskRecord {
  id: string;
  status: TaskStatus;
  session_id: string;
  /** True when this task created the session. */
  session_created: boolean;
  prompt: string;
  model: string;
  max_steps: number;
  timeout_ms: number;
  /** Absolute working directory the task runs in. */
  workdir: string;
  /** True: no other task may run in this workdir at the same time. */
  workdir_lock: boolean;
  /** Prompt-cache mode used for this task's requests. */
  cache: CacheMode;
  /** Names only — values are never persisted. */
  env_keys: string[];
  system_append?: string;
  /** Opaque JSON from the caller, echoed back untouched. */
  context?: unknown;
  callback?: CallbackSpec;
  callback_stats?: CallbackStats;

  created_at: string;
  started_at?: string;
  finished_at?: string;

  progress: TaskProgress;
  result?: TaskResult;
  error?: TaskError;
  /** Why it was cancelled (cancel reason), if cancelled. */
  cancel_reason?: string;
}

export type TaskEventType =
  | "task.queued"
  | "task.started"
  | "task.heartbeat"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.timed_out"
  | "step.started"
  | "step.finished"
  | "agent.text"
  | "agent.report"
  | "agent.todos"
  | "tool.started"
  | "tool.finished"
  | "tool.failed";

/** One line of `events.jsonl`, one SSE event, one webhook body. */
export interface TaskEvent {
  /** Per-task, starts at 1, strictly increasing, gap-free. */
  seq: number;
  ts: string;
  task_id: string;
  session_id: string;
  type: TaskEventType;
  data: Record<string, unknown>;
}

/** Body of `POST /v1/tasks`. */
export interface SubmitRequest {
  prompt: string;
  /** Client-chosen id = idempotency key. Generated if omitted. */
  task_id?: string;
  /** Continue this session; created if it does not exist. New session if omitted. */
  session_id?: string;
  model?: string;
  max_steps?: number;
  timeout_ms?: number;
  /**
   * Directory the task works in (absolute, or relative to the server's default
   * workdir). Required unless the server has a default workdir configured.
   * This is where relative paths and shell commands start — it is NOT a sandbox.
   */
  workdir?: string;
  /** Exclusive use of the workdir: wait until no other task runs there, block others meanwhile. */
  workdir_lock?: boolean;
  /** Prompt cache: "5m" | "1h" | "off" (default: server setting, "1h"). */
  cache?: CacheMode;
  env?: Record<string, string>;
  system_append?: string;
  context?: unknown;
  callback?: CallbackSpec;
}
