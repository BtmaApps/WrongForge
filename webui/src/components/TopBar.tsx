/** Brand + connection state + server facts + plan usage strip. */

import { useMemo } from "react";
import { useStore } from "../lib/store.js";
import { Chip, Tip } from "./bits.js";
import { fmtTokens } from "../lib/types.js";

export function TopBar() {
  const conn = useStore((s) => s.conn);
  const info = useStore((s) => s.info);
  const totals = useStore((s) => s.totals);
  const usage = useStore((s) => s.usage);
  const feed = useStore((s) => s.feed);

  const lastEventAge = useMemo(() => (feed.length ? feed[feed.length - 1]!.at : 0), [feed]);
  const connClass = conn === "open" ? "conn-open" : conn === "locked" ? "conn-locked" : "conn-wait";
  const connLabel =
    conn === "open" ? "live" : conn === "locked" ? "no key" : conn === "connecting" ? "connecting…" : "reconnecting…";
  const lastHint = lastEventAge ? ` · last event ${Math.max(0, Math.round((Date.now() - lastEventAge) / 1000))}s ago` : "";

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">⬢</span>
        <span className="brand-name">WrongForge</span>
        <span className="brand-sub">live dashboard</span>
      </div>

      <Tip text={`SSE /v1/events — ${connLabel}${lastHint}`}>
        <span className={`conn ${connClass}`}>
          <span className={`dot ${conn === "open" ? "dot-live" : ""}`} />
          {connLabel}
        </span>
      </Tip>

      {info && (
        <div className="topbar-chips">
          <Chip label="model" value={info.default_model} />
          <Chip label="effort" value={info.effort.default} tone="tone-cyan" />
          <Chip label="queue" value={`${info.queue.running}/${info.queue.max_concurrency} · ${info.queue.queued} queued`} />
          <Chip label="requests" value={String(totals.requests)} tone="tone-cyan" />
          <Chip label="tokens" value={`↑${fmtTokens(totals.in)} ↓${fmtTokens(totals.out)}`} tone="tone-violet" />
          <Chip label="cache read" value={fmtTokens(totals.cacheRead)} tone="tone-green" />
          <Chip label="tool calls" value={String(totals.toolCalls)} />
        </div>
      )}

      <div className="topbar-right">
        {usage && (
          <Tip
            text={`plan usage · 5h resets ${usage.five_hour.resetsAt ?? "?"}${usage.weekly ? ` · weekly ${usage.weekly.resetsAt ?? "?"}` : ""}`}
          >
            <div className="usage-mini">
              <span className="usage-label">5h</span>
              <span className="bar">
                <span className="bar-fill tone-violet" style={{ width: `${usage.five_hour.percent ?? 0}%` }} />
              </span>
              {usage.weekly && (
                <>
                  <span className="usage-label">wk</span>
                  <span className="bar">
                    <span className="bar-fill tone-cyan" style={{ width: `${usage.weekly.percent ?? 0}%` }} />
                  </span>
                </>
              )}
            </div>
          </Tip>
        )}
        {info && (
          <Tip text={`v${info.version} · ${info.signed_in ? "signed in" : "NOT signed in"} · cache ${info.cache.default}`}>
            <span className="ver">v{info.version}</span>
          </Tip>
        )}
      </div>
    </header>
  );
}
