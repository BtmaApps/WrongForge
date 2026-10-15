/**
 * Per-task execution context (AsyncLocalStorage).
 *
 * Several tasks can run concurrently in one server process, but the tools
 * (bash, read, glob, todo, …) were written against process-global state
 * (`process.cwd()`, a module-level todo list). This context gives every task
 * its own working directory, extra environment variables for shell commands,
 * todo list and progress-report channel — without changing the tool signatures.
 *
 * Outside a task (REPL, tests) there is no store and everything falls back to
 * the previous global behavior.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Todo } from "./tools/todo-state.js";
import type { CacheMode } from "./cache.js";
import type { EffortSetting } from "./effort.js";
import type { McpRegistry } from "./mcp/registry.js";

/** A semantic progress message the model sends via the `report_progress` tool. */
export interface ProgressReport {
  message: string;
  /** 0-100, optional */
  percent?: number;
  /** free-form label, e.g. "planning" | "implementing" | "verifying" */
  phase?: string;
}

export interface TaskContext {
  taskId?: string;
  /** Working directory of this task (absolute). */
  cwd: string;
  /** Extra environment variables merged into every shell command. */
  env: Record<string, string>;
  /** This task's todo list. */
  todos: Todo[];
  /** Called by the `report_progress` tool. */
  report?: (r: ProgressReport) => void;
  /** Prompt-cache mode for this task's requests (default: WRONGFORGE_CACHE or "1h"). */
  cache?: CacheMode;
  /** Reasoning effort for this task's requests, "off" = omit (default: WRONGFORGE_EFFORT or "high"). */
  effort?: EffortSetting;
  /** MCP registry the mcp_* tools use (default: the process-wide one). */
  mcp?: McpRegistry;
}

const als = new AsyncLocalStorage<TaskContext>();

/** Runs `fn` (and everything it awaits) inside `ctx`. */
export function runInContext<T>(ctx: TaskContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentContext(): TaskContext | undefined {
  return als.getStore();
}

/** The task's cwd, or the process cwd outside a task. */
export function workingDir(): string {
  return als.getStore()?.cwd ?? process.cwd();
}

/** Extra shell env for the current task (empty outside a task). */
export function extraEnv(): Record<string, string> {
  return als.getStore()?.env ?? {};
}
