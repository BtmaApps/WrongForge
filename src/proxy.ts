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
 */

import * as http from "node:http";
import { Readable } from "node:stream";
import type { ClaudeOAuth } from "./oauth.js";
import { PROTOCOL } from "./oauth.js";
import { oauthFetch } from "./provider.js";
import type { Logger } from "./log.js";

const DEFAULT_MAX_BODY = 32 * 1024 * 1024;

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

export interface ProxyOptions {
  oauth: ClaudeOAuth;
  logger: Logger;
}

/**
 * Builds the /v1/messages + /v1/models handler for createAgentServer. Returns
 * true when the request was one of the proxy routes (matched or failed on its
 * own terms); false lets dispatch fall through to its normal 404.
 */
export function createProxyHandler(opts: ProxyOptions) {
  const { oauth, logger } = opts;

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

    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
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
        init.body = await readBody(req);
        headers["content-type"] ??= "application/json";
      }

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
      res.writeHead(upstream.status, out);

      if (!upstream.body) {
        res.end();
      } else {
        const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
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
      } else {
        res.destroy();
      }
      logger.warn("proxy.error", { method, path: pathname, error: (e as Error).message });
      return true;
    }
  };
}
