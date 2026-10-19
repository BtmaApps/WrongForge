/**
 * The "Proxy" tab: every call WrongForge's Anthropic-compatible endpoint
 * (POST /v1/messages[/count_tokens], GET /v1/models) has actually forwarded —
 * request and response bodies included — so pointing a client's
 * ANTHROPIC_BASE_URL at this server is something you can watch happen.
 * Fed by its own `proxy.call` SSE channel (see store.ts), kept entirely out
 * of the Overview firehose so these (larger) payloads never crowd it out.
 */

import { useState } from "react";
import { useStore } from "../lib/store.js";
import { JsonPeek } from "./bits.js";
import { httpStatusClass } from "./LiveFeed.js";
import { summarizeAnthropicRequest, summarizeAnthropicResponse } from "../lib/anthropicSummary.js";
import type { ProxyCall } from "../lib/types.js";

/** 18100 -> "18.1k", 950 -> "950" — compact enough for an inline chip. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * Reads Anthropic's `anthropic-ratelimit-{requests,tokens}-{remaining,limit}`
 * response headers (already copied into the tap by proxy.ts's `out` filter)
 * into a compact "⚡ 42/50 req · 18.1k/20k tok" chip. Tone turns amber/red
 * as either remaining fraction drops — the single most actionable thing a
 * proxy dashboard can surface, since a 429 is otherwise a surprise.
 * Absent entirely on an error response that never reached upstream, or on
 * any upstream that simply doesn't send these (not every deployment does).
 */
function rateLimitSummary(headers: Record<string, string> | undefined): { text: string; tone?: string } | null {
  if (!headers) return null;
  const num = (name: string): number | undefined => {
    const v = headers[name];
    const n = v === undefined ? undefined : Number(v);
    return n !== undefined && Number.isFinite(n) ? n : undefined;
  };
  const reqRem = num("anthropic-ratelimit-requests-remaining");
  const reqLim = num("anthropic-ratelimit-requests-limit");
  const tokRem = num("anthropic-ratelimit-tokens-remaining");
  const tokLim = num("anthropic-ratelimit-tokens-limit");
  if (reqRem === undefined && tokRem === undefined) return null;

  const parts: string[] = [];
  if (reqRem !== undefined) parts.push(`${compact(reqRem)}${reqLim !== undefined ? `/${compact(reqLim)}` : ""} req`);
  if (tokRem !== undefined) parts.push(`${compact(tokRem)}${tokLim !== undefined ? `/${compact(tokLim)}` : ""} tok`);

  const fractions = [
    reqRem !== undefined && reqLim ? reqRem / reqLim : undefined,
    tokRem !== undefined && tokLim ? tokRem / tokLim : undefined,
  ].filter((f): f is number => f !== undefined);
  const worst = fractions.length ? Math.min(...fractions) : undefined;
  const tone = worst === undefined ? undefined : worst < 0.1 ? "tone-red" : worst < 0.3 ? "tone-amber" : undefined;

  return { text: `⚡ ${parts.join(" · ")}`, tone };
}

function ProxyCallRow({ call }: { call: ProxyCall }) {
  const [open, setOpen] = useState(false);
  const rl = rateLimitSummary(call.response_headers);
  return (
    <div className={`tool-card ${call.status >= 400 ? "tool-failed" : "tool-done"}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="feed-time">{call.ts.slice(11, 23)}</span>
        <span className={`feed-method m-${call.method.toLowerCase()}`}>{call.method}</span>
        <span className="feed-body feed-path mono">{call.path}</span>
        {call.model && <span className="chip"><span className="chip-value mono">{call.model}</span></span>}
        {call.stream && <span className="chip"><span className="chip-value">stream</span></span>}
        <span className={`chip ${call.auth_mode === "oauth" ? "tone-cyan" : "tone-amber"}`}>
          <span className="chip-value">{call.auth_mode}</span>
        </span>
        {rl && (
          <span className={`chip ${rl.tone ?? ""}`} title="anthropic-ratelimit-* headers from the last response">
            <span className="chip-value mono">{rl.text}</span>
          </span>
        )}
        <span className={`feed-status ${httpStatusClass(call.status)}`}>{call.status}</span>
        <span className={`feed-dur${call.duration_ms >= 1000 ? " dur-slow" : ""}`}>{call.duration_ms}ms</span>
        <span className="tool-io mono">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-io-col">
            <div className="io-label">
              request{call.request_truncated && <span className="dim"> (truncated — showing the first bytes only)</span>}
              {call.request_headers && Object.keys(call.request_headers).length > 0 && (
                <>
                  {" · "}
                  <JsonPeek
                    value={call.request_headers}
                    label={`${Object.keys(call.request_headers).length} header${Object.keys(call.request_headers).length === 1 ? "" : "s"}`}
                    max={0}
                  />
                </>
              )}
            </div>
            <JsonPeek value={call.request_body ?? "∅"} label={summarizeAnthropicRequest(call.request_body)} max={0} />
          </div>
          <div className="tool-io-col">
            <div className="io-label">
              response{call.response_truncated && <span className="dim"> (truncated — showing the first bytes only)</span>}
              {call.response_headers && Object.keys(call.response_headers).length > 0 && (
                <>
                  {" · "}
                  <JsonPeek
                    value={call.response_headers}
                    label={`${Object.keys(call.response_headers).length} header${Object.keys(call.response_headers).length === 1 ? "" : "s"}`}
                    max={0}
                  />
                </>
              )}
            </div>
            <JsonPeek value={call.response_body ?? "∅"} label={summarizeAnthropicResponse(call.response_body, { stream: call.stream })} max={0} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ProxyView() {
  const calls = useStore((s) => s.proxyCalls);

  return (
    <div className="feed">
      <div className="feed-toolbar">
        <span className="dim">
          Anthropic-compatible endpoint traffic — point a client's <span className="mono">ANTHROPIC_BASE_URL</span> at this
          server and its <span className="mono">/v1/messages</span> calls land here, bodies included.
        </span>
        <span className="feed-count">{calls.length} calls</span>
      </div>
      <div className="feed-scroll">
        {calls.length === 0 && (
          <div className="empty-panel">
            <div className="empty-title">no Anthropic-compatible calls yet</div>
            <p>
              This tab watches <span className="mono">POST /v1/messages</span>,{" "}
              <span className="mono">POST /v1/messages/count_tokens</span> and{" "}
              <span className="mono">GET /v1/models</span> — the surface any Anthropic client (Claude Code, the official
              SDKs, another WrongForge) can use once it is pointed at <span className="mono">{location.origin}</span> via{" "}
              <span className="mono">ANTHROPIC_BASE_URL</span>.
            </p>
            <p className="dim">An empty list here means no such client has called this server yet.</p>
          </div>
        )}
        {calls
          .slice()
          .reverse()
          .map((c) => (
            <ProxyCallRow key={c.id} call={c} />
          ))}
      </div>
    </div>
  );
}
