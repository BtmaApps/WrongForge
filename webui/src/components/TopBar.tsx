/** Brand + connection state + server facts + plan usage strip. */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../lib/store.js";
import { Chip, Tip } from "./bits.js";
import { fmtTokens } from "../lib/types.js";

export function TopBar() {
  const conn = useStore((s) => s.conn);
  const info = useStore((s) => s.info);
  const totals = useStore((s) => s.totals);
  const usage = useStore((s) => s.usage);
  const feed = useStore((s) => s.feed);
  const http = useStore((s) => s.http);
  const lastActivityAt = useStore((s) => s.lastActivityAt);

  // re-render every second so the "last event Ns ago" labels actually tick
  // instead of freezing until the next event arrives
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const lastEventAge = lastActivityAt || (feed.length ? feed[feed.length - 1]!.at : 0);
  const idleSec = lastEventAge ? Math.max(0, Math.round((now - lastEventAge) / 1000)) : null;
  const connClass = conn === "open" ? "conn-open" : conn === "locked" ? "conn-locked" : "conn-wait";
  const connLabel =
    conn === "open" ? "live" : conn === "locked" ? "no key" : conn === "connecting" ? "connecting…" : "reconnecting…";
  const lastHint = idleSec === null ? "" : ` · last event ${idleSec}s ago`;

  const rpm = useMemo(() => http.times.filter((t) => t > now - 60_000).length, [http, now]);
  const lastHttp = http.last;
  const lastHttpStatusTone = !lastHttp ? "" : lastHttp.status >= 500 ? "hstat-5xx" : lastHttp.status >= 400 ? "hstat-4xx" : "hstat-2xx";

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
          {idleSec !== null && <span className="conn-idle">{idleSec < 60 ? `${idleSec}s` : `${Math.round(idleSec / 60)}m`}</span>}
        </span>
      </Tip>

      {info && (
        <div className="topbar-chips">
          {info.update && (
            <Tip text={`new release · ${info.update.url} — run \`wrongforge update\` on the server`}>
              <Chip label="update" value={`v${info.update.latest} available`} tone="tone-red" />
            </Tip>
          )}
          <Tip text={`effort ${info.effort.default} · tools ${info.tools.length} · ${info.mcp.servers} MCP servers`}>
            <Chip label="model" value={info.default_model} />
          </Tip>
          <Chip label="queue" value={`${info.queue.running}/${info.queue.max_concurrency} · ${info.queue.queued} queued`} />
          <Chip label="requests" value={String(totals.requests)} tone="tone-cyan" />
          <Chip
            label="http"
            value={`${http.total} · ${rpm}/min${http.errors ? ` · ${http.errors} err` : ""}`}
            tone={http.errors ? "tone-red" : rpm > 0 ? "tone-green" : undefined}
          />
          <Chip label="tokens" value={`↑${fmtTokens(totals.in)} ↓${fmtTokens(totals.out)}`} tone="tone-violet" />
          <Chip label="cache read" value={fmtTokens(totals.cacheRead)} tone="tone-green" />
        </div>
      )}

      <div className="topbar-right">
        {lastHttp && (
          <Tip text={`last API request · ${lastHttp.duration_ms}ms`}>
            {/* key remounts on every request → the ping animation replays */}
            <span className="http-last" key={http.total}>
              <span className="http-last-ping" />
              <span className="http-last-method">{lastHttp.method}</span>
              <span className="http-last-path">{lastHttp.path}</span>
              <span className={`http-last-status ${lastHttpStatusTone}`}>{lastHttp.status}</span>
              <span className="http-last-age">
                {lastHttp.duration_ms}ms · {Math.max(0, Math.round((now - lastHttp.at) / 1000))}s ago
              </span>
            </span>
          </Tip>
        )}
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
