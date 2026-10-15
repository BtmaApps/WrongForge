/**
 * Task table + a rich detail dialog: per-step what-went-out (step.request) /
 * what-came-back (text deltas, tool calls with inputs/outputs, usage footer).
 */

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../lib/api.js";
import { store, useStore } from "../lib/store.js";
import type { TaskEvent, TaskRecord } from "../lib/types.js";
import { fmtTokens, shortId } from "../lib/types.js";
import { Bar, Chip, JsonPeek, StatusBadge, Tip } from "./bits.js";

export function TasksView({ openTaskId, setOpenTaskId }: { openTaskId: string | null; setOpenTaskId: (id: string | null) => void }) {
  const tasks = useStore((s) => s.tasks);
  const sorted = useMemo(
    () => [...tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [tasks],
  );
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const rows = sorted.filter((t) => statusFilter === "all" || t.status === statusFilter);

  return (
    <div className="tasks">
      <div className="feed-toolbar">
        <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {["all", "running", "queued", "completed", "failed", "cancelled", "timed_out"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="feed-count">
          {rows.length} tasks
        </span>
      </div>
      <div className="tasks-scroll">
        <table className="task-table">
          <thead>
            <tr>
              <th>status</th>
              <th>task</th>
              <th>prompt</th>
              <th>model</th>
              <th>effort</th>
              <th>steps</th>
              <th>tools</th>
              <th>context</th>
              <th>age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="task-row" onClick={() => setOpenTaskId(t.id)}>
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td className="mono">{shortId(t.id, 16)}</td>
                <td className="prompt-cell" title={t.prompt}>
                  {t.progress.current_tool && (
                    <Tip text={`running ${t.progress.current_tool.name}`}>
                      <span className="dot dot-live" />
                    </Tip>
                  )}
                  {t.prompt.slice(0, 80) || <span className="dim">—</span>}
                </td>
                <td className="mono">{shortId(t.model.replace("claude-", ""), 18)}</td>
                <td className="mono dim">{t.effort ?? "—"}</td>
                <td className="mono">
                  {t.progress.steps}/{t.max_steps}
                </td>
                <td className="mono">{t.progress.tool_calls}</td>
                <td className="ctx-cell">
                  {t.result ? (
                    <Tip text={`${fmtTokens(t.result.context_tokens)} / ${fmtTokens(t.result.context_window)} tokens`}>
                      <span className="ctx-cell-inner">
                        <Bar percent={t.result.context_percent} />
                        <span className="mono dim">{t.result.context_percent}%</span>
                      </span>
                    </Tip>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td className="mono dim">{t.created_at ? ageOf(t.created_at) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">no tasks{statusFilter !== "all" ? " with this status" : ""} yet</div>}
      </div>
      <TaskDetail taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
    </div>
  );
}

function ageOf(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Folded view of one task's events: steps with their requests and results. */
interface StepBlock {
  step: number;
  request?: TaskEvent;
  started?: TaskEvent;
  finished?: TaskEvent;
  text: string;
  tools: Array<{ call: TaskEvent; result?: TaskEvent; error?: TaskEvent }>;
  others: TaskEvent[];
}

function foldSteps(events: TaskEvent[]): { pre: TaskEvent[]; steps: StepBlock[]; post: TaskEvent[] } {
  const pre: TaskEvent[] = [];
  const post: TaskEvent[] = [];
  const steps: StepBlock[] = [];
  let cur: StepBlock | null = null;
  const openTool = new Map<string, { call: TaskEvent; result?: TaskEvent; error?: TaskEvent }>();
  for (const ev of events) {
    if (ev.type === "task.heartbeat") continue;
    if (ev.type === "step.started" || ev.type === "step.request") {
      const n: number = Number(ev.data.step ?? 0) || (cur ? cur.step + 1 : 1);
      if (!cur || cur.step !== n) {
        cur = { step: n, text: "", tools: [], others: [] };
        steps.push(cur);
      }
      if (ev.type === "step.request") cur.request = ev;
      else cur.started = ev;
      continue;
    }
    if (!cur) {
      pre.push(ev);
      continue;
    }
    switch (ev.type) {
      case "agent.text":
        cur.text += String(ev.data.text ?? "");
        break;
      case "tool.started": {
        const entry = { call: ev };
        cur.tools.push(entry);
        openTool.set(String(ev.data.tool_call_id ?? ""), entry);
        break;
      }
      case "tool.finished": {
        const entry = openTool.get(String(ev.data.tool_call_id ?? ""));
        if (entry) entry.result = ev;
        else cur.tools.push({ call: ev });
        break;
      }
      case "tool.failed": {
        const entry = openTool.get(String(ev.data.tool_call_id ?? ""));
        if (entry) entry.error = ev;
        else cur.tools.push({ call: ev });
        break;
      }
      case "step.finished":
        cur.finished = ev;
        break;
      default:
        cur.others.push(ev);
    }
  }
  return { pre, steps, post };
}

export function TaskDetail({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const tasks = useStore((s) => s.tasks);
  const perTask = useStore((s) => s.perTask);
  const doc = taskId ? tasks.get(taskId) : undefined;
  const events = taskId ? perTask.get(taskId) : undefined;
  const [fetchedDoc, setFetchedDoc] = useState<TaskRecord | null>(null);

  useEffect(() => {
    if (!taskId) {
      setFetchedDoc(null);
      return;
    }
    void store.backfillEvents(taskId);
    setFetchedDoc(null);
    void (async () => {
      try {
        const res = await api<{ task: TaskRecord }>(`/v1/tasks/${taskId}`, store.getState().key);
        setFetchedDoc(res.task);
      } catch {
        /* the live doc is usually enough */
      }
    })();
  }, [taskId]);

  const t = doc ?? fetchedDoc ?? undefined;
  const folded = useMemo(() => foldSteps(events ?? []), [events]);

  return (
    <Dialog.Root open={Boolean(taskId)} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-task">
          <div className="dialog-header">
            <Dialog.Title className="dialog-title mono">{taskId ?? ""}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="dialog-close" aria-label="close">
                ✕
              </button>
            </Dialog.Close>
          </div>
          {t ? (
            <>
              <div className="task-meta">
                <StatusBadge status={t.status} />
                <Chip label="model" value={t.model} />
                <Chip label="effort" value={t.effort ?? "—"} tone="tone-cyan" />
                <Chip label="cache" value={t.cache ?? "—"} />
                <Chip label="session" value={shortId(t.session_id, 14)} />
                <Chip label="steps" value={`${t.progress.steps}/${t.max_steps}`} />
                <Chip label="workdir" value={t.workdir} />
                {t.result && <Chip label="duration" value={`${Math.round(t.result.duration_ms / 1000)}s`} />}
                {t.result && (
                  <Chip label="tokens" value={`↑${fmtTokens(t.result.usage.input_tokens)} ↓${fmtTokens(t.result.usage.output_tokens)}`} tone="tone-violet" />
                )}
              </div>
              <div className="task-prompt mono">{t.prompt || <span className="dim">(no prompt captured)</span>}</div>
              {t.error && <div className="task-error">{t.error.code}: {t.error.message}</div>}
              <div className="task-steps">
                {folded.pre
                  .filter((ev) => ev.type !== "task.started" && ev.type !== "task.queued")
                  .map((ev) => (
                    <EventLine key={ev.seq} ev={ev} />
                  ))}
                {folded.steps.map((s) => (
                  <div key={s.step} className="step">
                    <div className="step-head">
                      <span className="step-no">step {s.step}</span>
                      {s.request && (
                        <span className="step-req mono">
                          → {String(s.request.data.model)} · effort {String(s.request.data.effort ?? "—")} ·{" "}
                          {String(s.request.data.messages)} msgs · {String(s.request.data.tools)} tools · max{" "}
                          {String(s.request.data.max_tokens)}
                        </span>
                      )}
                      {s.finished && (
                        <span className="step-fin mono">
                          ← {String(s.finished.data.finish_reason)} · in{" "}
                          {fmtTokens(Number((s.finished.data.usage as { input_tokens?: number })?.input_tokens ?? 0))} · out{" "}
                          {fmtTokens(Number((s.finished.data.usage as { output_tokens?: number })?.output_tokens ?? 0))} · ctx{" "}
                          {fmtTokens(Number(s.finished.data.context_tokens ?? 0))}
                        </span>
                      )}
                    </div>
                    {s.tools.map((tool, i) => (
                      <ToolCard key={`${tool.call.seq}-${i}`} tool={tool} />
                    ))}
                    {s.text && <pre className="step-text">{s.text}</pre>}
                  </div>
                ))}
                {folded.steps.length === 0 && <div className="empty">no events for this task (yet)</div>}
              </div>
            </>
          ) : (
            <div className="empty">loading task…</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ToolCard({ tool }: { tool: { call: TaskEvent; result?: TaskEvent; error?: TaskEvent } }) {
  const [open, setOpen] = useState(false);
  const name = String(tool.call.data.name ?? "?");
  const external = Boolean(tool.call.data.external);
  const state = tool.error ? "failed" : tool.result ? "done" : "running";
  return (
    <div className={`tool-card tool-${state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-state ts-${state}`}>{state === "running" ? "◌" : state === "failed" ? "✕" : "✓"}</span>
        <span className="tool-name mono">
          {name}
          {external && <span className="ext-badge">ext</span>}
        </span>
        <span className="tool-io mono">
          {open ? "hide io" : "show io"}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-io-col">
            <div className="io-label">input</div>
            <JsonPeek value={tool.call.data.input} label="raw" max={0} />
          </div>
          <div className="tool-io-col">
            <div className="io-label">{tool.error ? "error" : "output"}</div>
            <JsonPeek value={tool.error ? tool.error.data.error : tool.result?.data.output} label="raw" max={0} />
          </div>
        </div>
      )}
    </div>
  );
}

function EventLine({ ev }: { ev: TaskEvent }) {
  return (
    <div className={`feed-row ${ev.type.startsWith("task.") ? "ev-task" : "ev-dim"}`}>
      <span className="feed-time">{ev.ts.slice(11, 23)}</span>
      <span className="feed-type">{ev.type}</span>
      <span className="feed-body">{JSON.stringify(ev.data).slice(0, 140)}</span>
    </div>
  );
}
