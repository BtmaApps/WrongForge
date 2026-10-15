/**
 * The firehose: every task event as it happens, newest at the bottom,
 * filterable. Heartbeats are hidden by default (they would drown everything).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import * as Switch from "@radix-ui/react-switch";
import { useStore } from "../lib/store.js";
import { JsonPeek } from "./bits.js";
import { shortId } from "../lib/types.js";

const TYPE_TONE: Record<string, string> = {
  "http.request": "ev-http",
  "task.queued": "ev-task",
  "task.started": "ev-task",
  "task.completed": "ev-done",
  "task.failed": "ev-error",
  "task.cancelled": "ev-warn",
  "task.timed_out": "ev-warn",
  "task.heartbeat": "ev-dim",
  "step.started": "ev-step",
  "step.request": "ev-req",
  "step.finished": "ev-res",
  "agent.text": "ev-text",
  "agent.report": "ev-report",
  "agent.todos": "ev-report",
  "tool.started": "ev-tool",
  "tool.finished": "ev-tool-done",
  "tool.failed": "ev-error",
  "tools.loaded": "ev-tool",
  "context.cleared": "ev-warn",
  "session.compacting": "ev-dim",
  "session.compacted": "ev-dim",
};

function summarize(type: string, data: Record<string, unknown>): string {
  const u = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const result = data.result as
    | { steps?: number; tool_calls?: number; text?: string; usage?: { input_tokens?: number; output_tokens?: number } }
    | undefined;
  const err = data.error as { code?: string; message?: string } | string | undefined;
  switch (type) {
    case "http.request":
      return `${data.method} ${data.path} → ${data.status} · ${data.duration_ms}ms`;
    case "task.started":
      return `model=${data.model} workdir=${data.workdir} effort=${data.effort ?? "?"}`;
    case "task.completed":
      return `steps=${result?.steps ?? "?"} tools=${result?.tool_calls ?? "?"} · ↑${result?.usage?.input_tokens ?? "?"} ↓${result?.usage?.output_tokens ?? "?"} · ${String(result?.text ?? "").slice(0, 70)}`;
    case "task.failed":
      return typeof err === "string"
        ? err.slice(0, 120)
        : `${err?.code ?? ""} ${err?.message ?? ""}`.trim().slice(0, 120);
    case "step.request":
      return `→ model=${data.model} effort=${data.effort ?? "—"} msgs=${data.messages} tools=${data.tools} max=${data.max_tokens}`;
    case "step.finished":
      return `← ${data.finish_reason} in=${u?.input_tokens ?? "?"} out=${u?.output_tokens ?? "?"} ctx=${data.context_tokens}`;
    case "tool.started":
      return `${data.name}${data.external ? " (external)" : ""} ${JSON.stringify(data.input).slice(0, 90)}`;
    case "tool.finished":
      return `${data.name} ok=${String(data.ok ?? "?")}`;
    case "tool.failed":
      return `${data.name}: ${String(data.error).slice(0, 90)}`;
    case "agent.report":
      return `${data.phase ? `[${data.phase}] ` : ""}${data.message}${data.percent !== undefined ? ` (${data.percent}%)` : ""}`;
    case "agent.text":
      return String(data.text ?? "").slice(0, 120);
    case "task.heartbeat":
      return `elapsed=${Math.round(Number(data.elapsed_ms ?? 0) / 1000)}s`;
    default:
      return "";
  }
}

export function LiveFeed({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const feed = useStore((s) => s.feed);
  const [filter, setFilter] = useState("all");
  const [showHeartbeats, setShowHeartbeats] = useState(false);
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      feed.filter((r) => {
        if (!showHeartbeats && r.ev.type === "task.heartbeat") return false;
        if (filter === "all") return true;
        if (filter === "http") return r.ev.type === "http.request";
        if (filter === "tasks") return r.ev.type.startsWith("task.");
        if (filter === "steps") return r.ev.type.startsWith("step.");
        if (filter === "tools") return r.ev.type.startsWith("tool");
        if (filter === "text") return r.ev.type.startsWith("agent.");
        return true;
      }),
    [feed, filter, showHeartbeats],
  );

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [rows.length, follow]);

  return (
    <div className="feed">
      <div className="feed-toolbar">
        <ToggleGroup.Root
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v)}
          className="seg"
          aria-label="filter events"
        >
          <ToggleGroup.Item value="all" className="seg-item">
            all
          </ToggleGroup.Item>
          <ToggleGroup.Item value="http" className="seg-item">
            http
          </ToggleGroup.Item>
          <ToggleGroup.Item value="tasks" className="seg-item">
            tasks
          </ToggleGroup.Item>
          <ToggleGroup.Item value="steps" className="seg-item">
            model steps
          </ToggleGroup.Item>
          <ToggleGroup.Item value="tools" className="seg-item">
            tools
          </ToggleGroup.Item>
          <ToggleGroup.Item value="text" className="seg-item">
            agent
          </ToggleGroup.Item>
        </ToggleGroup.Root>
        <label className="switch-row">
          <Switch.Root checked={showHeartbeats} onCheckedChange={setShowHeartbeats} className="switch">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          heartbeats
        </label>
        <label className="switch-row">
          <Switch.Root checked={follow} onCheckedChange={setFollow} className="switch">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          follow
        </label>
        <span className="feed-count">
          {rows.length}/{feed.length} events
        </span>
      </div>
      <div className="feed-scroll" ref={boxRef}>
        {rows.length === 0 && <div className="empty">waiting for events — submit a task and watch it flow…</div>}
        {rows.map((r) => (
          <div key={r.key} className={`feed-row ${TYPE_TONE[r.ev.type] ?? ""}`}>
            <span className="feed-time">{r.ev.ts.slice(11, 23)}</span>
            <span className="feed-type">{r.ev.type}</span>
            <button className="feed-task" onClick={() => onOpenTask(r.ev.task_id)} title="open task detail">
              {shortId(r.ev.task_id, 14)}
            </button>
            <span className="feed-body">{summarize(r.ev.type, r.ev.data)}</span>
            <JsonPeek value={r.ev.data} label="{ }" max={0} />
          </div>
        ))}
      </div>
    </div>
  );
}
