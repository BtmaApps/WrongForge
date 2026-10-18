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

function ProxyCallRow({ call }: { call: ProxyCall }) {
  const [open, setOpen] = useState(false);
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
        <span className={`feed-status ${httpStatusClass(call.status)}`}>{call.status}</span>
        <span className={`feed-dur${call.duration_ms >= 1000 ? " dur-slow" : ""}`}>{call.duration_ms}ms</span>
        <span className="tool-io mono">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-io-col">
            <div className="io-label">
              request{call.request_truncated && <span className="dim"> (truncated — showing the first bytes only)</span>}
            </div>
            <JsonPeek value={call.request_body ?? "∅"} label={summarizeAnthropicRequest(call.request_body)} max={0} />
          </div>
          <div className="tool-io-col">
            <div className="io-label">
              response{call.response_truncated && <span className="dim"> (truncated — showing the first bytes only)</span>}
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
