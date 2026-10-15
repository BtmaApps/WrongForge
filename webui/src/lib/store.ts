/**
 * The dashboard's single source of truth.
 *
 * A snapshot (GET /v1/info, /v1/tasks, /v1/sessions, /v1/usage) is merged with
 * the live global feed (GET /v1/events SSE): every task event updates the task
 * documents, the aggregate counters and the graph pulses, so all views stay
 * consistent without per-view polling. React binds via useSyncExternalStore.
 */

import { useSyncExternalStore } from "react";
import { api, connectEvents, saveKey, type SseStatus } from "./api.js";
import type { Info, PlanUsage, SessionMeta, TaskEvent, TaskRecord, TokenUsage } from "./types.js";

const FEED_CAP = 1200;
const PER_TASK_CAP = 600;

export interface FeedRow {
  key: string;
  at: number;
  ev: TaskEvent;
}

export interface ToolStat {
  calls: number;
  errors: number;
  running: number;
  lastAt: number;
}

export interface Totals {
  steps: number;
  requests: number;
  toolCalls: number;
  in: number;
  out: number;
  cacheRead: number;
}

export type ConnectionState = "locked" | SseStatus;

export interface State {
  key: string;
  conn: ConnectionState;
  info: Info | null;
  usage: PlanUsage | null;
  tasks: Map<string, TaskRecord>;
  sessions: SessionMeta[];
  feed: FeedRow[];
  perTask: Map<string, TaskEvent[]>;
  tools: Map<string, ToolStat>;
  totals: Totals;
  /** edge-id / node-id -> last-activity ts, drives the graph animations. */
  pulses: Map<string, number>;
  authError: string | null;
}

const initial: State = {
  key: "",
  conn: "locked",
  info: null,
  usage: null,
  tasks: new Map(),
  sessions: [],
  feed: [],
  perTask: new Map(),
  tools: new Map(),
  totals: { steps: 0, requests: 0, toolCalls: 0, in: 0, out: 0, cacheRead: 0 },
  pulses: new Map(),
  authError: null,
};

type Listener = () => void;

class Store {
  private state: State = initial;
  private listeners = new Set<Listener>();
  private disconnect: (() => void) | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;

  getState = (): State => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private set(patch: (s: State) => Partial<State>): void {
    this.state = { ...this.state, ...patch(this.state) };
    this.emit();
  }

  // ------------------------------------------------------------ connection

  /** Validate the key, load the snapshot, start the live feed. */
  async connect(key: string): Promise<boolean> {
    if (!key.trim()) return false;
    let info: Info;
    try {
      info = await api<Info>("/v1/info", key);
    } catch (e) {
      this.set(() => ({ authError: (e as Error).message }));
      return false;
    }
    saveKey(key);
    this.set(() => ({ key, info, authError: null, conn: "connecting" }));
    await this.refresh();
    this.disconnectSse();
    this.disconnect = connectEvents(
      key,
      (ev) => this.applyEvent(ev),
      (s) => {
        this.set(() => ({ conn: s }));
        if (s === "open") void this.refresh(); // live-only feed: catch up after a gap
      },
    );
    if (!this.usageTimer) {
      this.usageTimer = setInterval(() => void this.refreshUsage(), 90_000);
    }
    void this.refreshUsage();
    return true;
  }

  disconnectSse(): void {
    this.disconnect?.();
    this.disconnect = null;
  }

  shutdown(): void {
    this.disconnectSse();
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
  }

  /** Snapshot of everything queryable; keeps tasks/sessions fresh. */
  async refresh(): Promise<void> {
    const key = this.state.key;
    if (!key) return;
    try {
      const [tasksRes, sessionsRes] = await Promise.all([
        api<{ tasks: TaskRecord[] }>("/v1/tasks?limit=300", key),
        api<{ sessions: SessionMeta[] }>("/v1/sessions", key),
      ]);
      const tasks = new Map(tasksRes.tasks.map((t) => [t.id, t]));
      this.set((s) => ({
        tasks,
        sessions: sessionsRes.sessions,
        // keep events of tasks the list no longer returns (retention) — the
        // detail view reads them until the task is dismissed
        perTask: new Map([...s.perTask].filter(([id]) => tasks.has(id) || s.perTask.get(id)!.length < PER_TASK_CAP)),
      }));
    } catch {
      /* transient — the next reconnect retries */
    }
  }

  async refreshUsage(): Promise<void> {
    if (!this.state.key) return;
    try {
      const usage = await api<PlanUsage>("/v1/usage", this.state.key);
      this.set(() => ({ usage }));
    } catch {
      this.set(() => ({ usage: null }));
    }
  }

  /** Historical events for a task the dashboard connected after (or live tail). */
  async backfillEvents(taskId: string): Promise<void> {
    const key = this.state.key;
    if (!key) return;
    try {
      const res = await api<{ events: TaskEvent[]; terminal: boolean }>(`/v1/tasks/${taskId}/events?limit=5000`, key);
      if (!res.events.length) return;
      this.set((s) => {
        const known = s.perTask.get(taskId) ?? [];
        const seen = new Set(known.map((e) => e.seq));
        const merged = [...known, ...res.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
        const perTask = new Map(s.perTask);
        perTask.set(taskId, merged.slice(-PER_TASK_CAP));
        return { perTask };
      });
    } catch {
      /* task vanished — the doc fetch will surface that */
    }
  }

  // ------------------------------------------------------------ live events

  applyEvent(ev: TaskEvent): void {
    const at = Date.now();
    this.set((s) => {
      const feed = [...s.feed, { key: `${ev.task_id}:${ev.seq}`, at, ev }];
      const perTask = new Map(s.perTask);
      perTask.set(ev.task_id, [...(perTask.get(ev.task_id) ?? []), ev].slice(-PER_TASK_CAP));

      const tasks = new Map(s.tasks);
      const doc = tasks.get(ev.task_id);
      if (doc) tasks.set(ev.task_id, patchTask(doc, ev));

      const tools = new Map(s.tools);
      const pulses = new Map(s.pulses);
      const totals = { ...s.totals };
      pulse(pulses, `task:${ev.task_id}`, at);

      switch (ev.type) {
        case "step.started":
          totals.steps++;
          break;
        case "step.request": {
          totals.requests++;
          pulse(pulses, `model:${String(ev.data.model ?? "")}`, at);
          pulse(pulses, `edge:${ev.task_id}>model:${String(ev.data.model ?? "")}`, at);
          break;
        }
        case "step.finished": {
          const u = ev.data.usage as TokenUsage | undefined;
          if (u) {
            totals.in += u.input_tokens ?? 0;
            totals.out += u.output_tokens ?? 0;
            totals.cacheRead += u.cache_read_tokens ?? 0;
          }
          pulse(pulses, `edge:model:${doc?.model ?? ""}>${ev.task_id}`, at);
          break;
        }
        case "tool.started": {
          const name = String(ev.data.name ?? "?");
          const st = { ...(tools.get(name) ?? { calls: 0, errors: 0, running: 0, lastAt: at }) };
          st.calls++;
          st.running++;
          st.lastAt = at;
          tools.set(name, st);
          totals.toolCalls++;
          pulse(pulses, `tool:${name}`, at);
          pulse(pulses, `edge:${ev.task_id}>tool:${name}`, at);
          break;
        }
        case "tool.finished": {
          const name = String(ev.data.name ?? "?");
          const st = { ...(tools.get(name) ?? { calls: 0, errors: 0, running: 0, lastAt: at }) };
          st.running = Math.max(0, st.running - 1);
          st.lastAt = at;
          tools.set(name, st);
          pulse(pulses, `edge:tool:${name}>${ev.task_id}`, at);
          break;
        }
        case "tool.failed": {
          const name = String(ev.data.name ?? "?");
          const st = { ...(tools.get(name) ?? { calls: 0, errors: 0, running: 0, lastAt: at }) };
          st.errors++;
          st.running = Math.max(0, st.running - 1);
          tools.set(name, st);
          break;
        }
        case "task.queued":
        case "task.started": {
          if (!doc) {
            tasks.set(ev.task_id, {
              id: ev.task_id,
              session_id: ev.session_id,
              status: ev.type === "task.queued" ? "queued" : "running",
              prompt: "",
              model: String(ev.data.model ?? ""),
              created_at: ev.ts,
              progress: { last_event_seq: ev.seq, steps: 0, tool_calls: 0, last_activity_at: ev.ts },
            } as TaskRecord);
          }
          break;
        }
      }

      return { feed: feed.slice(-FEED_CAP), perTask, tasks, tools, totals, pulses };
    });
  }
}

function pulse(pulses: Map<string, number>, id: string, at: number): void {
  pulses.set(id, at);
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Folds an event into the task document so list views stay current. */
function patchTask(doc: TaskRecord, ev: TaskEvent): TaskRecord {
  const d: TaskRecord = { ...doc, progress: { ...doc.progress, last_event_seq: ev.seq, last_activity_at: ev.ts } };
  switch (ev.type) {
    case "task.started":
      d.status = "running";
      d.started_at = ev.ts;
      break;
    case "task.completed":
    case "task.failed":
    case "task.cancelled":
    case "task.timed_out":
      d.status = ev.type.split(".")[1] as TaskRecord["status"];
      d.finished_at = ev.ts;
      break;
    case "step.started":
      d.progress.steps = Math.max(d.progress.steps, Number(ev.data.step ?? 0));
      break;
    case "tool.started":
      d.progress.tool_calls++;
      d.progress.current_tool = {
        id: String(ev.data.tool_call_id ?? ""),
        name: String(ev.data.name ?? ""),
        started_at: ev.ts,
      };
      break;
    case "tool.finished":
    case "tool.failed":
      d.progress.current_tool = undefined;
      break;
    case "agent.report":
      d.progress.last_report = {
        message: String(ev.data.message ?? ""),
        percent: ev.data.percent as number | undefined,
        phase: ev.data.phase as string | undefined,
        at: ev.ts,
      };
      break;
    case "agent.todos":
      d.progress.todos = ev.data.todos as TaskRecord["progress"]["todos"];
      break;
    case "task.completed":
      break;
  }
  return d;
}

export const store = new Store();

/** Binds a selector to the store (select stable references; derive in useMemo). */
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => sel(store.getState()),
    () => sel(initial),
  );
}
