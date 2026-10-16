/**
 * The everything page: server identity and settings, the model lineup with
 * each model's effort levels, plan usage (5h + weekly), limits, tools, MCP
 * and data dirs — a read-only rendering of /v1/info + /v1/usage.
 */

import { useStore } from "../lib/store.js";
import { Bar, Chip, Tip } from "./bits.js";

const fmtBytes = (n: number): string =>
  n >= 1_000_000 ? `${Math.round(n / 1_000_000)} MB` : n >= 1000 ? `${Math.round(n / 1000)} kB` : `${n} B`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="info-sec">
      <h2 className="info-h">{title}</h2>
      {children}
    </section>
  );
}

function UsageRow({ label, window }: { label: string; window: { percent: number | null; resetsAt: string | null } | null }) {
  if (!window) return null;
  const pct = window.percent ?? 0;
  return (
    <div className="insp-usage-row">
      <span className="usage-name">{label}</span>
      <Bar percent={pct} tone={pct >= 90 ? "tone-warn" : "violet"} />
      <span className="mono dim">{pct}%</span>
      <Tip text={window.resetsAt ? `resets ${new Date(window.resetsAt).toLocaleString()}` : "reset time unknown"}>
        <span className="mono dim usage-reset">{window.resetsAt ? new Date(window.resetsAt).toLocaleTimeString() : "—"}</span>
      </Tip>
    </div>
  );
}

export function InfoView() {
  const info = useStore((s) => s.info);
  const usage = useStore((s) => s.usage);
  if (!info) return <div className="empty">not connected…</div>;

  const models = info.model_details ?? info.models.map((id) => ({ id, description: "", effort_levels: [] as string[] }));

  return (
    <div className="info-page">
      <Section title="server">
        <div className="insp-grid">
          <Chip label="name" value={info.name} />
          <Chip label="version" value={`v${info.version}`} />
          <Chip label="protocol" value={String(info.protocol)} />
          <Chip label="account" value={info.signed_in ? "signed in" : "NOT signed in"} tone={info.signed_in ? "tone-green" : "tone-red"} />
          <Chip label="default model" value={info.default_model} />
          <Chip label="effort default" value={info.effort.default} tone="tone-cyan" />
          <Chip label="effort levels" value={info.effort.levels.join(" · ")} />
          <Chip label="queue" value={`${info.queue.running}/${info.queue.max_concurrency} running · ${info.queue.queued} queued`} />
          <Chip label="cache" value={`${info.cache.default} (${info.cache.modes.join("|")})`} />
          <Chip label="features" value={info.features.join(" · ") || "—"} />
        </div>
      </Section>

      <Section title="models & effort">
        <table className="info-table">
          <thead>
            <tr>
              <th>model</th>
              <th>description</th>
              <th>effort levels</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} className={m.id === info.default_model ? "info-row-default" : ""}>
                <td className="mono">
                  {m.id}
                  {m.id === info.default_model && <span className="default-badge">default</span>}
                </td>
                <td className="dim">{m.description || "—"}</td>
                <td>
                  {m.effort_levels.length ? (
                    <span className="effort-levels">
                      {m.effort_levels.map((l) => (
                        <span key={l} className={`effort-pill ${l === info.effort.default ? "effort-on" : ""}`}>
                          {l}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="plan usage">
        {usage ? (
          <div className="insp-usage">
            <UsageRow label="5h window" window={usage.five_hour} />
            <UsageRow label="weekly" window={usage.weekly} />
            {usage.extra_usage?.enabled && (
              <div className="insp-grid" style={{ marginTop: 6 }}>
                <Chip
                  label="extra usage"
                  value={`used ${usage.extra_usage.usedCredits ?? "?"} / ${usage.extra_usage.monthlyLimit ?? "?"} credits`}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="dim">usage unavailable (signed in? the server caches it 5 min)</div>
        )}
      </Section>

      <Section title="workdir & limits">
        <div className="insp-grid">
          <Chip label="default workdir" value={info.workdir.default ?? "— (required per task)"} />
          <Chip label="workdir lock" value={info.workdir.lock_by_default ? "by default" : "opt-in"} />
          <Chip label="allowed roots" value={info.workdir.allowed_roots?.length ? info.workdir.allowed_roots.join(" ; ") : "unrestricted"} />
          <Chip label="context window" value={`${Math.round(info.context.window / 1000)}k · compact at ${Math.round(info.context.compact_at / 1000)}k · clear at ${Math.round(info.context.clear_at / 1000)}k`} />
          <Chip label="max body" value={fmtBytes(info.limits.max_body_bytes)} />
          <Chip label="steps" value={`default ${info.limits.default_max_steps} · max ${info.limits.max_steps}`} />
          <Chip label="webhook" value={info.webhook.signature} tone="tone-cyan" />
        </div>
      </Section>

      <Section title={`tools (${info.tools.length})`}>
        <div className="effort-levels">
          {info.tools.map((t) => (
            <span key={t} className="effort-pill">{t}</span>
          ))}
        </div>
        {info.tool_guides.length > 0 && <div className="dim" style={{ marginTop: 8 }}>tool guides: {info.tool_guides.join(", ")}</div>}
      </Section>

      <Section title="storage & mcp">
        <div className="insp-grid">
          <Chip label="data" value={info.dirs.home} />
          <Chip label="logs" value={info.dirs.logs} />
          <Chip label="tasks" value={info.dirs.tasks} />
          <Chip label="sessions" value={info.dirs.sessions} />
          <Chip label="mcp" value={`${info.mcp.servers} server(s) · ${info.mcp.config_file}`} />
        </div>
      </Section>
    </div>
  );
}
