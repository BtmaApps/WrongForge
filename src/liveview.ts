/**
 * The serve-console live view: every incoming HTTP request and every task
 * event as one colored line on stdout, right where `npm run serve` runs.
 *
 *   20:31:05 → GET  /v1/tasks                        200    2ms
 *   20:31:05 ● task.started   tsk_ab12  claude-sonnet-5-5 · effort high · D:\w
 *   20:31:05 ⇢ step.request   tsk_ab12  #1 → sonnet msgs 3 tools 24 max 32000
 *   20:31:05 ⚑ tool.started   tsk_ab12  ls {"path":"."}
 *   20:31:05 ✔ task.completed tsk_ab12  2 steps · 1 tool · 12s
 *
 * Enabled by default when stdout is a TTY (a real terminal); pipes/tests
 * stay quiet. WRONGFORGE_LIVE=1 forces it on, =0 off. NO_COLOR disables the
 * colors. Heartbeats are skipped — they would drown everything else.
 */

import type { HttpTapEvent } from "./server.js";
import type { TaskEvent } from "./tasks/types.js";

/** Everything the view needs, structurally (tests pass stubs). */
export interface LiveViewDeps {
  /** Task event source (the manager). */
  events: { subscribe(fn: (ev: TaskEvent) => void): () => void };
  /** Live HTTP traffic (the server's tap bus). */
  httpTaps: Set<(e: HttpTapEvent) => void>;
}

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  violet: "\x1b[35m",
  blue: "\x1b[34m",
};

const noColor = (): boolean => Boolean(process.env.NO_COLOR);

const paint = (color: string, s: string): string => (noColor() ? s : `${color}${s}${C.reset}`);

const trunc = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

const fmt = (n: unknown): string =>
  typeof n === "number" ? (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)) : "?";

function ts(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const SYM: Record<string, string> = {
  "task.queued": "○",
  "task.started": "●",
  "task.completed": "✔",
  "task.failed": "✖",
  "task.cancelled": "⊘",
  "task.timed_out": "⏱",
  "step.request": "⇢",
  "step.finished": "⇠",
  "tool.started": "⚑",
  "tool.finished": "✓",
  "tool.failed": "✗",
  "agent.text": "✎",
  "agent.report": "❝",
  "tools.loaded": "⚙",
  "context.cleared": "⌫",
  "session.compacting": "⧗",
  "session.compacted": "⧖",
};

function color(ev: TaskEvent): string {
  if (ev.type === "task.completed") return C.green;
  if (ev.type === "task.failed" || ev.type === "tool.failed") return C.red;
  if (ev.type === "step.request") return C.cyan;
  if (ev.type === "step.finished") return C.blue;
  if (ev.type.startsWith("tool.")) return C.green;
  if (ev.type.startsWith("task.")) return C.violet;
  return C.dim;
}

/** One compact summary of the event's data (never throws on odd payloads). */
export function describeEvent(ev: TaskEvent): string {
  const d = ev.data as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (ev.type) {
    case "task.queued":
      return `position ${String(d.position ?? 0)}${d.waiting_for ? ` · waiting: ${s(d.waiting_for)}` : ""}`;
    case "task.started":
      return `${s(d.model)} · effort ${s(d.effort) || "—"} · ${s(d.workdir)}`;
    case "step.request":
      return `#${String(d.step)} → ${s(d.model)} · msgs ${String(d.messages)} · tools ${String(d.tools)} · max ${fmt(d.max_tokens)} · effort ${s(d.effort) || "—"}`;
    case "step.finished": {
      const u = d.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return `#${String(d.step)} ${s(d.finish_reason)} · in ${fmt(u?.input_tokens)} out ${fmt(u?.output_tokens)} · ctx ${fmt(d.context_tokens)}`;
    }
    case "tool.started":
      return `${s(d.name)}${d.external ? " (ext)" : ""} ${trunc(safeJson(d.input), 70)}`;
    case "tool.finished":
      return `${s(d.name)} ${d.ok === false ? "ok=false" : "ok"}`;
    case "tool.failed":
      return `${s(d.name)}: ${trunc(s(d.error), 90)}`;
    case "agent.text":
      return trunc(s(d.text), 100);
    case "agent.report":
      return `${d.phase ? `[${s(d.phase)}] ` : ""}${s(d.message)}${d.percent !== undefined ? ` (${String(d.percent)}%)` : ""}`;
    case "task.completed": {
      const u = d.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return `${String(d.steps)} steps · ${String(d.tool_calls)} tools · in ${fmt(u?.input_tokens)} out ${fmt(u?.output_tokens)}`;
    }
    case "task.failed":
      return `${s(d.code)} ${trunc(s(d.error), 110)}`;
    case "task.cancelled":
      return s(d.reason) || "cancelled";
    case "tools.loaded":
      return `${s(d.source)} +${String(d.count)}${d.error ? ` · error: ${trunc(s(d.error), 60)}` : ""}`;
    case "context.cleared":
      return `cleared ${String(d.cleared)} · ctx ${fmt(d.context_tokens)}`;
    default:
      return trunc(safeJson(d), 100);
  }
}

function safeJson(v: unknown): string {
  if (v === undefined || v === null) return "";
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Starts the console view. Returns a stop function (tests use it; the server
 * runs it for the lifetime of the process).
 */
export function startLiveView(
  deps: LiveViewDeps,
  opts: { force?: boolean; write?: (line: string) => void } = {},
): () => void {
  const enabled = opts.force ?? (process.env.WRONGFORGE_LIVE === "1"
    ? true
    : process.env.WRONGFORGE_LIVE === "0"
      ? false
      : Boolean(process.stdout.isTTY));
  if (!enabled) return () => {};

  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const onHttp = (e: HttpTapEvent): void => {
    const status = e.status >= 500 ? paint(C.red, String(e.status)) : e.status >= 400 ? paint(C.yellow, String(e.status)) : paint(C.green, String(e.status));
    write(`${paint(C.dim, `${ts(e.ts)} →`)} ${paint(C.dim, e.method.padEnd(5))} ${paint(C.dim, e.path.padEnd(38))} ${status} ${paint(C.dim, `${e.duration_ms}ms`)}`);
  };
  const onEvent = (ev: TaskEvent): void => {
    if (ev.type === "task.heartbeat") return;
    const sym = paint(color(ev), SYM[ev.type] ?? "·");
    const type = paint(color(ev), ev.type.padEnd(15));
    write(`${paint(C.dim, `${ts(ev.ts)} `)}${sym} ${type} ${paint(C.dim, trunc(ev.task_id, 14).padEnd(14))} ${describeEvent(ev)}`);
  };

  deps.httpTaps.add(onHttp);
  const unsub = deps.events.subscribe(onEvent);
  return () => {
    deps.httpTaps.delete(onHttp);
    unsub();
  };
}
