/**
 * The left rail: every task as one compact row — status, id, age, prompt
 * snippet, live step/tool counters. Click selects it in the inspector;
 * queued/running tasks get an inline cancel.
 */

import { useMemo, useState } from "react";
import { store, useStore } from "../lib/store.js";
import { fmtAge, shortId } from "../lib/types.js";

const RAIL_DOT: Record<string, string> = {
  queued: "rd-queued",
  running: "rd-running",
  completed: "rd-completed",
  failed: "rd-failed",
  cancelled: "rd-cancelled",
  timed_out: "rd-timed_out",
};

type RailFilter = "all" | "active" | "ended";

export function TaskRail({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const tasks = useStore((s) => s.tasks);
  const [filter, setFilter] = useState<RailFilter>("all");

  const rows = useMemo(
    () =>
      [...tasks.values()]
        .filter((t) =>
          filter === "all"
            ? true
            : filter === "active"
              ? t.status === "running" || t.status === "queued"
              : t.status !== "running" && t.status !== "queued",
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [tasks, filter],
  );

  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">tasks</span>
        <div className="seg seg-mini">
          {(["all", "active", "ended"] as const).map((f) => (
            <button key={f} className={`seg-item ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        <span className="feed-count">
          {rows.length}
        </span>
      </div>
      <div className="rail-scroll">
        {rows.map((t) => (
          <div
            key={t.id}
            className={`rail-row ${selectedId === t.id ? "selected" : ""}`}
            onClick={() => onSelect(t.id)}
          >
            <div className="rail-row-top">
              <span className={`rail-dot ${RAIL_DOT[t.status] ?? ""} ${t.status === "running" ? "pulse" : ""}`} title={t.status} />
              <span className="mono rail-id">{shortId(t.id, 16)}</span>
              <span className="mono dim rail-age">{fmtAge(t.created_at)}</span>
              {(t.status === "running" || t.status === "queued") && (
                <button
                  className="cancel-btn"
                  title="cancel this task"
                  onClick={(e) => {
                    e.stopPropagation();
                    void store.cancelTask(t.id);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            <div className="rail-prompt">{t.prompt || "—"}</div>
            <div className="rail-sub mono dim">
              <span>{t.progress.steps} steps</span>
              <span>{t.progress.tool_calls} tools</span>
              {t.progress.current_tool && <span className="rail-now">↻ {t.progress.current_tool.name}</span>}
              {t.progress.last_report && <span className="rail-report">{t.progress.last_report.message.slice(0, 40)}</span>}
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="empty">no tasks{filter !== "all" ? ` (${filter})` : ""}</div>}
      </div>
    </aside>
  );
}
