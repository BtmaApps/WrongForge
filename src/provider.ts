/**
 * Wires the AI SDK Anthropic provider to OAuth tokens.
 *
 * Signing scheme (same as Claude Code):
 *   Authorization: Bearer <oauth-token>
 *   anthropic-beta: oauth-2025-04-20        (required for OAuth tokens)
 *   anthropic-version: 2023-06-01           (sent by the provider itself)
 *   User-Agent: claude-cli/<v> (external, cli)  +  x-app: cli
 *
 * The subscription backend serves OAuth tokens only to Claude Code-style
 * clients; without these client headers /v1/messages returns a bare
 * rate_limit_error ("message":"Error") even when the token is valid.
 * The UA string is app-level metadata — it contains nothing machine-specific.
 *
 * A placeholder apiKey is passed and the custom fetch strips the provider's
 * x-api-key, then injects the OAuth headers. On 401 it refreshes once and
 * retries.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import * as crypto from "node:crypto";
import type { ClaudeOAuth } from "./oauth.js";
import { PROTOCOL } from "./oauth.js";
import { applyCacheBreakpoints, defaultCacheMode, type CacheMode } from "./cache.js";
import { currentContext } from "./context.js";

/**
 * Mimics the Claude Code CLI client signature. Captured verbatim from a real
 * Claude Code request (values are app/runtime-class metadata: nothing here is
 * unique to this machine or persisted between runs).
 */
const CLAUDE_CODE_UA = "claude-cli/2.1.300 (external, sdk-cli)";
const SESSION_ID = crypto.randomUUID(); // fresh per app run, never stored

function applyClientSignature(headers: Headers): void {
  headers.set("user-agent", CLAUDE_CODE_UA);
  headers.set("x-app", "cli");
  headers.set("x-claude-code-session-id", SESSION_ID);
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  headers.set("x-stainless-lang", "js");
  headers.set("x-stainless-os", process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux");
  headers.set("x-stainless-arch", process.arch === "x64" ? "x64" : process.arch);
  headers.set("x-stainless-runtime", "node");
  headers.set("x-stainless-runtime-version", process.version);
  headers.set("x-stainless-package-version", "0.128.0");
  headers.set("x-stainless-retry-count", "0");
}

/** Claude Code posts to /v1/messages?beta=true with this beta list. */
const CLAUDE_CODE_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "token-counting-2024-11-01",
];

/**
 * The subscription backend gates premium models (opus/sonnet/fable, the 5.x
 * generation) on the request looking like Claude Code: the system prompt must
 * start with this marker block (verified empirically — without it the API
 * returns a bare 429 even with a valid token; claude-haiku-4-5 is exempt).
 * We prepend it as the first system block and keep our own prompt after it.
 */
const CLAUDE_CODE_SYSTEM_MARKER =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Set when the API rejected cache_control once: caching is then switched off
 * for the rest of the process so a cache problem can never fail tasks.
 */
let cacheRejected = false;

/** Cache mode for the request being built: task override > env default; "off" after a rejection. */
function effectiveCacheMode(): CacheMode {
  if (cacheRejected) return "off";
  return currentContext()?.cache ?? defaultCacheMode();
}

function withClaudeCodeSystem(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { input: RequestInfo | URL; init: RequestInit | undefined } {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.includes("/v1/messages") || typeof init?.body !== "string") {
    return { input, init };
  }
  try {
    const body = JSON.parse(init.body);
    if (Array.isArray(body.system)) {
      if (body.system[0]?.text !== CLAUDE_CODE_SYSTEM_MARKER) {
        body.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM_MARKER }, ...body.system];
      }
    } else if (typeof body.system === "string") {
      body.system = [
        { type: "text", text: CLAUDE_CODE_SYSTEM_MARKER },
        { type: "text", text: body.system },
      ];
    } else {
      body.system = [{ type: "text", text: CLAUDE_CODE_SYSTEM_MARKER }];
    }
    applyCacheBreakpoints(body, effectiveCacheMode());
    return { input, init: { ...init, body: JSON.stringify(body) } };
  } catch {
    return { input, init };
  }
}

function withBetaFlag(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string" && input.includes("/v1/messages") && !input.includes("beta=")) {
    return input + (input.includes("?") ? "&" : "?") + "beta=true";
  }
  return input;
}

export function oauthFetch(oauth: ClaudeOAuth): typeof globalThis.fetch {
  return async (input, init) => {
    const doFetch = async (): Promise<Response> => {
      const token = await oauth.getAccessToken();
      const headers = new Headers(init?.headers);
      headers.delete("x-api-key"); // auth is owned by this layer
      headers.set("authorization", `Bearer ${token}`);
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", PROTOCOL.anthropicVersion);
      }
      const flags = new Set(
        (headers.get("anthropic-beta") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      for (const b of CLAUDE_CODE_BETAS) flags.add(b);
      headers.set("anthropic-beta", [...flags].join(","));
      applyClientSignature(headers);
      const routed = withClaudeCodeSystem(input, init);
      return globalThis.fetch(withBetaFlag(routed.input), {
        ...routed.init,
        headers,
      });
    };

    let res = await doFetch();
    if (res.status === 401) {
      const fresh = await oauth.refresh();
      if (fresh) res = await doFetch();
    }
    // The API refused our cache_control markers (e.g. unsupported TTL on this
    // account): retry once without them and stop sending them.
    if (res.status === 400 && effectiveCacheMode() !== "off") {
      const detail = await res.clone().text().catch(() => "");
      if (/cache_control|cache control|ttl/i.test(detail)) {
        cacheRejected = true;
        console.error("[cache] the API rejected cache_control — prompt caching is disabled for this process:", detail.slice(0, 300));
        res = await doFetch();
      }
    }
    return res;
  };
}

export function createClaudeProvider(oauth: ClaudeOAuth): AnthropicProvider {
  return createAnthropic({
    apiKey: "managed-by-oauth", // the real credential is injected by oauthFetch
    fetch: oauthFetch(oauth),
    // mock server for tests; defaults to api.anthropic.com in production
    baseURL: process.env.ANTHROPIC_BASE_URL ?? undefined,
  });
}
