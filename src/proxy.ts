/**
 * Anthropic-compatible proxy endpoints — the server-side mirror of the
 * provider: any Anthropic client (Claude Code, the SDKs, WrongStack, curl)
 * can point ANTHROPIC_BASE_URL at this server and talk to the same backend
 * the agent itself uses.
 *
 *   POST /v1/messages                    streaming + non-streaming, piped 1:1
 *   POST /v1/messages/count_tokens
 *   GET  /v1/models, GET /v1/models/:id
 *
 * Client auth is the server's own API key (`x-api-key` or Bearer — the
 * Anthropic SDKs send `x-api-key`). Upstream is chosen exactly like the agent
 * path in provider.ts:
 *
 *   ANTHROPIC_API_KEY set  plain fetch, body passed through byte-for-byte,
 *                          only the credential swapped in
 *   otherwise (OAuth)      oauthFetch(oauth) — Bearer token, the Claude Code
 *                          client signature and the required body costume
 *                          (billing system block, metadata, request shape);
 *                          without them the subscription answers 400
 *                          "Third-party apps now draw from your extra usage".
 *                          401 token refresh and the 400 self-heal rides along.
 *   ANTHROPIC_BASE_URL     the upstream origin for either mode (chained
 *                          proxies, tests).
 *
 * Responses pass through untouched: status, SSE events, `anthropic-*` and
 * rate-limit headers, error envelopes. WRONGFORGE_PROXY=0 turns the surface
 * off; WRONGFORGE_PROXY_MAX_BODY caps the request body (default 32 MB — the
 * task API's 1 MB is too small for long contexts and inline images).
 *
 * Dashboard visibility: every call also produces one `ProxyCallEvent` (via
 * the optional `onTap` callback), carrying a size-capped copy of the request
 * and response bodies for the webui's "Proxy" tab. This is a UI convenience,
 * entirely separate from the real request/response path above — the capture
 * never buffers or delays what the client actually receives (see the tee
 * comment below), and its own cap (WRONGFORGE_PROXY_TAP_BODY_CAP, default
 * 8 KB) is independent of WRONGFORGE_PROXY_MAX_BODY.
 */

import * as http from "node:http";
import { Readable } from "node:stream";
import type { ClaudeOAuth } from "./oauth.js";
import { PROTOCOL } from "./oauth.js";
import { oauthFetch } from "./provider.js";
import { sanitize, type Logger } from "./log.js";

const DEFAULT_MAX_BODY = 32 * 1024 * 1024;
const DEFAULT_TAP_BODY_CAP = 8 * 1024;

/** Route shapes served by the proxy (raw path, nothing decoded). */
const PROXY_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/v1\/messages\/count_tokens$/ },
  { method: "POST", pattern: /^\/v1\/messages$/ },
  { method: "GET", pattern: /^\/v1\/models\/[^/]+$/ },
  { method: "GET", pattern: /^\/v1\/models$/ },
];

/** Client request headers that survive into the upstream call. Credentials,
 * content-length (the OAuth costume can change the body's length) and
 * hop-by-hop headers never do — the client's WrongForge key must not leak
 * upstream and a stale length would corrupt the forwarded body. */
const FORWARD_REQUEST_HEADERS = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta"]);
/** Upstream response headers copied back verbatim; every `anthropic-*`
 * (rate limits, request ids) is forwarded in addition. */
const FORWARD_RESPONSE_HEADERS = new Set(["content-type", "retry-after", "request-id"]);

export function proxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRONGFORGE_PROXY !== "0";
}

export function proxyMaxBody(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WRONGFORGE_PROXY_MAX_BODY);
  return Number.isFinite(raw) && raw >= 1024 ? Math.floor(raw) : DEFAULT_MAX_BODY;
}

/** UI-display cap for the dashboard's captured request/response bodies —
 * independent of proxyMaxBody(), which bounds what the proxy itself accepts. */
export function proxyTapBodyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WRONGFORGE_PROXY_TAP_BODY_CAP);
  return Number.isFinite(raw) && raw >= 256 ? Math.floor(raw) : DEFAULT_TAP_BODY_CAP;
}

function upstreamBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "").replace(/\/v\d+$/, "");
  return raw || "https://api.anthropic.com";
}

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One captured /v1/messages-surface call, broadcast to the dashboard's
 * "Proxy" tab over the existing /v1/events SSE feed (never persisted, never
 * part of the task event protocol — same spirit as HttpTapEvent). Bodies are
 * size-capped copies for display, independent of the real request/response
 * bytes the client actually exchanged.
 */
export interface ProxyCallEvent {
  type: "proxy.call";
  /** Monotonic per-process id ("pc_<n>") — exact frontend dedup, unlike
   *  HttpTapEvent's tuple-hash (no id travels with that one). */
  id: string;
  ts: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  auth_mode: "oauth" | "api_key";
  /** Parsed out of the request body when present (absent for GET /v1/models). */
  model?: string;
  stream?: boolean;
  request_body?: unknown;
  request_truncated: boolean;
  response_body?: unknown;
  response_truncated: boolean;
  /** The subset of client request headers actually forwarded upstream
   *  (FORWARD_REQUEST_HEADERS) — e.g. the anthropic-beta flags this
   *  particular client asked for. Captured before credentials are injected,
   *  so it never contains x-api-key. */
  request_headers?: Record<string, string>;
  /** The subset of upstream response headers forwarded back to the client
   *  (FORWARD_RESPONSE_HEADERS plus the anthropic-* rule) — rate limits,
   *  request-id, retry-after. Absent when the call never reached upstream
   *  (e.g. 503 not_signed_in, 502 upstream_unreachable). */
  response_headers?: Record<string, string>;
}

/** Parses a captured body string for display: small valid JSON becomes an
 * object (pretty in the dashboard's JSON viewer); anything over `cap` bytes
 * or not valid JSON (e.g. raw SSE event text) is kept as a capped raw string. */
function captureBody(raw: string | undefined, cap: number): { body: unknown; truncated: boolean } {
  if (raw === undefined || raw === "") return { body: undefined, truncated: false };
  if (raw.length > cap) return { body: raw.slice(0, cap), truncated: true };
  try {
    return { body: JSON.parse(raw), truncated: false };
  } catch {
    return { body: raw, truncated: false };
  }
}

export interface ProxyOptions {
  oauth: ClaudeOAuth;
  logger: Logger;
  /** Fired once per call (success or failure) with a size-capped tap event
   *  for the dashboard; never affects the real request/response. */
  onTap?: (e: ProxyCallEvent) => void;
}

/**
 * Builds the /v1/messages + /v1/models handler for createAgentServer. Returns
 * true when the request was one of the proxy routes (matched or failed on its
 * own terms); false lets dispatch fall through to its normal 404.
 */
export function createProxyHandler(opts: ProxyOptions) {
  const { oauth, logger, onTap } = opts;
  let tapSeq = 0;

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const cap = proxyMaxBody();
      let size = 0;
      const chunks: Buffer[] = [];
      let overflowed = false;
      req.on("data", (c: Buffer) => {
        if (overflowed) return; // drain so the 413 reaches the client
        size += c.length;
        if (size > cap) {
          overflowed = true;
          chunks.length = 0;
          reject(new ProxyError(413, "body_too_large", `request body exceeds ${cap} bytes (WRONGFORGE_PROXY_MAX_BODY)`));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!overflowed) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", (e) => reject(new ProxyError(400, "invalid_request", (e as Error).message)));
    });

  return async function proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    pathname: string,
    search: string,
  ): Promise<boolean> {
    const started = Date.now();
    if (!PROXY_ROUTES.some((r) => r.method === method && r.pattern.test(pathname))) return false;

    // Fields the tap event is assembled from as the call progresses; emitted
    // exactly once, from whichever exit point the call takes.
    let requestBodyRaw: string | undefined;
    let parsedRequest: Record<string, unknown> | undefined;
    let authMode: "oauth" | "api_key" = "oauth";
    let requestHeaders: Record<string, string> | undefined;
    let responseHeaders: Record<string, string> | undefined;

    const emitTap = (status: number, responseRaw: string | undefined, responseTruncated: boolean): void => {
      if (!onTap) return;
      const cap = proxyTapBodyCap();
      const req1 = captureBody(requestBodyRaw, cap);
      const res1 = responseTruncated ? { body: responseRaw, truncated: true } : captureBody(responseRaw, cap);
      onTap({
        type: "proxy.call",
        id: `pc_${++tapSeq}`,
        ts: new Date(started).toISOString(),
        method,
        path: pathname,
        status,
        duration_ms: Date.now() - started,
        auth_mode: authMode,
        model: typeof parsedRequest?.model === "string" ? parsedRequest.model : undefined,
        stream: typeof parsedRequest?.stream === "boolean" ? parsedRequest.stream : undefined,
        request_body: sanitize(req1.body, 1_000_000),
        request_truncated: req1.truncated,
        response_body: sanitize(res1.body, 1_000_000),
        response_truncated: res1.truncated,
        request_headers: sanitize(requestHeaders, 2000) as Record<string, string> | undefined,
        response_headers: sanitize(responseHeaders, 2000) as Record<string, string> | undefined,
      });
    };

    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      authMode = apiKey ? "api_key" : "oauth";
      if (!apiKey && !oauth.signedIn) {
        throw new ProxyError(503, "not_signed_in", "WrongForge is not signed in (run `npm run import` or `npm run login`) and ANTHROPIC_API_KEY is not set");
      }

      const headers: Record<string, string> = {};
      for (const name of FORWARD_REQUEST_HEADERS) {
        const v = req.headers[name];
        const one = Array.isArray(v) ? v[0] : v;
        if (typeof one === "string" && one) headers[name] = one;
      }

      const init: RequestInit = { method, headers };
      if (method === "POST") {
        requestBodyRaw = await readBody(req);
        init.body = requestBodyRaw;
        headers["content-type"] ??= "application/json";
        try {
          parsedRequest = JSON.parse(requestBodyRaw);
        } catch {
          /* not JSON — model/stream stay undefined, upstream will reject it */
        }
      }
      // snapshot before credentials are injected below — x-api-key must
      // never reach the tap, even redacted
      requestHeaders = { ...headers };

      // the client owns the connection lifetime: when it walks away the
      // upstream request is aborted so nothing streams into a dead socket
      const abort = new AbortController();
      init.signal = abort.signal;
      res.on("close", () => abort.abort());

      const url = upstreamBase() + pathname + (search || "");
      let upstream: Response;
      if (apiKey) {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] ??= PROTOCOL.anthropicVersion;
        upstream = await globalThis.fetch(url, init);
      } else {
        upstream = await oauthFetch(oauth)(url, init);
      }

      const out: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        const n = name.toLowerCase();
        if (FORWARD_RESPONSE_HEADERS.has(n) || n.startsWith("anthropic-")) out[n] = value;
      });
      out["content-type"] ??= "application/json";
      responseHeaders = out;
      res.writeHead(upstream.status, out);

      if (!upstream.body) {
        res.end();
        emitTap(upstream.status, undefined, false);
      } else {
        const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
        // Tap capture: mirrors the bytes into a capped buffer alongside the
        // real pipe below. Multiple "data" listeners on one Readable all
        // receive every chunk (plain EventEmitter fan-out) — this does not
        // participate in the pipe's backpressure and never slows or buffers
        // what the client receives; once the cap is hit it simply stops
        // accumulating, it never pauses the source.
        const cap = proxyTapBodyCap();
        const capture: Buffer[] = [];
        let capturedBytes = 0;
        let captureTruncated = false;
        stream.on("data", (chunk: Buffer) => {
          if (captureTruncated || !onTap) return;
          if (capturedBytes + chunk.length > cap) {
            capture.push(chunk.subarray(0, Math.max(0, cap - capturedBytes)));
            capturedBytes = cap;
            captureTruncated = true;
            return;
          }
          capture.push(chunk);
          capturedBytes += chunk.length;
        });
        // Idempotent: "end"/"error"/the client-disconnect "close" below can
        // each fire in different orders (a normal completion closes the
        // connection too, right after "end"), but the tap must only ever be
        // emitted once per call (F105).
        let finished = false;
        const finish = (forceTruncated?: boolean): void => {
          if (finished) return;
          finished = true;
          emitTap(upstream.status, Buffer.concat(capture).toString("utf8"), forceTruncated ?? captureTruncated);
        };
        stream.on("end", finish);
        stream.on("error", () => {
          res.destroy();
          finish();
        });
        res.on("close", () => {
          stream.destroy();
          // The client hung up before the upstream stream naturally ended:
          // destroy() fires neither "end" nor "error" on `stream`, so without
          // this the call — headers already sent, tokens already billed
          // upstream — would vanish from the dashboard forever (F105).
          // Whatever was captured is necessarily incomplete, hence `true`.
          finish(true);
        });
        stream.pipe(res);
      }
      logger.info("proxy.request", {
        method, path: pathname, status: upstream.status,
        duration_ms: Date.now() - started,
      });
      return true;
    } catch (e) {
      if (e instanceof ProxyError) {
        if (!res.headersSent && !res.destroyed) {
          const body = JSON.stringify({ error: { code: e.code, message: e.message } });
          res.writeHead(e.status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
          emitTap(e.status, body, false);
        }
        logger.warn("proxy.error", { method, path: pathname, code: e.code, status: e.status });
        return true;
      }
      // client disconnects surface as AbortError from the upstream fetch —
      // the socket is already gone, nothing to answer
      if ((e as Error).name === "AbortError" || res.destroyed || res.writableEnded) {
        res.destroy();
        return true;
      }
      if (!res.headersSent) {
        const body = JSON.stringify({ error: { code: "upstream_unreachable", message: (e as Error).message } });
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
        emitTap(502, body, false);
      } else {
        res.destroy();
      }
      logger.warn("proxy.error", { method, path: pathname, error: (e as Error).message });
      return true;
    }
  };
}
