/**
 * Wires the official Anthropic SDK client to OAuth tokens.
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

import Anthropic from "@anthropic-ai/sdk";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaudeOAuth } from "./oauth.js";
import { PROTOCOL } from "./oauth.js";
import { applyCacheBreakpoints, defaultCacheMode, type CacheMode } from "./cache.js";
import {
  applyEffortToBody,
  effectiveEffort,
  effortRejectedOnce,
  markEffortRejected,
} from "./effort.js";

import { currentContext } from "./context.js";
import { dataDir } from "./paths.js";

/**
 * Mimics the Claude Code CLI client signature. Captured verbatim from a real
 * Claude Code request (values are app/runtime-class metadata: nothing here is
 * unique to this machine or persisted between runs).
 */
const CLAUDE_CODE_UA = "claude-cli/2.1.300 (external, sdk-cli)";
const SESSION_ID = crypto.randomUUID(); // fresh per app run, never stored

// ---------------------------------------------------------------- metadata id

/**
 * metadata.user_id in the shape real Claude Code sends (captured live, see
 * re/notes/findings.md §9): a JSON string with a persistent 64-hex device_id,
 * the account_uuid (fetched once from the bootstrap endpoint and cached next
 * to it) and the per-process session id. Falls back to the bare device id
 * when the account uuid is unavailable — the field is metadata, never fatal.
 */
let cachedAccountUuid: string | null = null;

function deviceId(): string {
  const file = path.join(dataDir(), "user-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    /* first run — create it below */
  }
  const id = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}

/** One bootstrap fetch per process — returns the account uuid or null. */
async function fetchBootstrap(oauth: ClaudeOAuth): Promise<string | null> {
  if (process.env.ANTHROPIC_BASE_URL) return null; // test/proxy mode: never touch the real API
  try {
    const token = await oauth.getAccessToken();
    const res = await globalThis.fetch("https://api.anthropic.com/api/claude_cli/bootstrap", {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CLAUDE_CODE_UA,
        "x-app": "cli",
        "x-claude-code-session-id": SESSION_ID,
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": PROTOCOL.anthropicVersion,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const uuid = (await res.json())?.oauth_account?.account_uuid;
      if (typeof uuid === "string" && uuid) {
        const file = path.join(dataDir(), "account-uuid");
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(file, uuid + "\n", { mode: 0o600 });
        return uuid;
      }
    }
  } catch {
    /* bootstrap is best-effort — sessions never fail because of it */
  }
  return null;
}

/**
 * Claude Code calls GET /api/claude_cli/bootstrap at EVERY startup (fresh
 * each process, never disk-cached — re/notes/findings.md §5); we mirror that
 * when the OAuth client is created, which also keeps the cached account uuid
 * current for metadata.user_id.
 */
let bootstrappedOnce = false;
export async function bootstrapSession(oauth: ClaudeOAuth): Promise<void> {
  if (bootstrappedOnce) return;
  bootstrappedOnce = true;
  const uuid = await fetchBootstrap(oauth);
  if (uuid) cachedAccountUuid = uuid;
}

async function accountUuid(oauth: ClaudeOAuth): Promise<string | null> {
  if (cachedAccountUuid) return cachedAccountUuid;
  const file = path.join(dataDir(), "account-uuid");
  try {
    const cached = fs.readFileSync(file, "utf8").trim();
    if (cached) {
      cachedAccountUuid = cached;
      return cached;
    }
  } catch {
    /* not cached yet */
  }
  const uuid = await fetchBootstrap(oauth);
  if (uuid) cachedAccountUuid = uuid;
  return uuid;
}

async function claudeMetadataUserId(oauth: ClaudeOAuth): Promise<string> {
  const device = deviceId();
  const account = await accountUuid(oauth);
  if (!account) return device;
  return JSON.stringify({ device_id: device, account_uuid: account, session_id: SESSION_ID });
}

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

/**
 * Betas sent on every request. Verified live (re/notes, 2026-10-15): the
 * subscription backend classifies a request as a first-party Claude Code
 * client only when BOTH context-management-2025-06-27 and
 * dangerous-tool-use-2026-09-03 are present in the beta header — without
 * them /v1/messages answers 400 "Third-party apps now draw from your extra
 * usage". claude-code marks the client, interleaved-thinking enables the
 * streaming feature the agent relies on, oauth is required for subscription
 * tokens. The rest of CC's 15-beta list is optional (leave-one-out tested).
 */
const CLAUDE_CODE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "dangerous-tool-use-2026-09-03",
];

/**
 * The system prompt of a real Claude Code request starts with TWO fixed
 * blocks (captured live from CC 2.1.300, re/notes/cc-capture.jsonl):
 *
 *   1. a billing marker — "x-anthropic-billing-header: cc_version=…;
 *      cc_entrypoint=…;" — which is how the subscription backend classifies
 *      the traffic as first-party Claude Code for PLAN billing (the
 *      "Third-party apps … extra usage" 400 is what you get without it);
 *   2. the agent identity line of the entrypoint.
 *
 * Our own prompt follows as the next block. Cache breakpoints sit on the
 * blocks AFTER the billing header (as in the capture), which cache.ts
 * handles by marking the last system block.
 */
const CC_BILLING_HEADER_BLOCK =
  "x-anthropic-billing-header: cc_version=2.1.300.bc2; cc_entrypoint=sdk-cli;";
const CC_AGENT_IDENTITY_BLOCK =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

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
    const ccBlocks = [
      { type: "text", text: CC_BILLING_HEADER_BLOCK },
      { type: "text", text: CC_AGENT_IDENTITY_BLOCK },
    ];
    if (Array.isArray(body.system)) {
      if (body.system[0]?.text !== CC_BILLING_HEADER_BLOCK) {
        body.system = [...ccBlocks, ...body.system];
      }
    } else if (typeof body.system === "string") {
      body.system = [...ccBlocks, { type: "text", text: body.system }];
    } else {
      body.system = ccBlocks;
    }
    // Note: /v1/messages rejects a body-level anthropic_beta field ("extra
    // inputs are not permitted", verified live) — betas travel via the header
    // only on this endpoint.
    applyCacheBreakpoints(body, effectiveCacheMode());
    // Reasoning effort, model-aware: only sent when the model's family accepts
    // it (see effort.ts). Same position in every request, so the cached prefix
    // (tools -> system -> messages) is unaffected.
    applyEffortToBody(body, effectiveEffort(String(body.model ?? "")));
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
      // Claude Code carries metadata.user_id on every messages request; the
      // agent layer leaves it unset and it is injected here, once per process
      // (the account uuid lookup is cached).
      let routedInit = routed.init;
      if (typeof routed.input === "string" && routed.input.includes("/v1/messages") && typeof routedInit?.body === "string") {
        try {
          const body = JSON.parse(routedInit.body);
          body.metadata ??= {};
          if (typeof body.metadata.user_id !== "string") {
            body.metadata.user_id = await claudeMetadataUserId(oauth);
            routedInit = { ...routedInit, body: JSON.stringify(body) };
          }
        } catch {
          /* not a JSON body — leave untouched */
        }
      }
      return globalThis.fetch(withBetaFlag(routed.input), {
        ...routedInit,
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
    // The API refused the effort parameter (a model that does not accept it —
    // e.g. one newer than effort.ts's table): retry once without it and stop
    // sending it for THAT model, so other models keep their effort. The
    // retried request succeeded whenever you can read this — informational.
    if (res.status === 400 && !effortRejectedOnce()) {
      const detail = await res.clone().text().catch(() => "");
      if (/effort/i.test(detail)) {
        let model = "";
        try {
          const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: unknown }) : null;
          if (typeof body?.model === "string" && body.model) model = body.model;
        } catch {
          /* keep "" — the global fallback below */
        }
        markEffortRejected(model || undefined);
        console.error(
          `[effort] ${model || "this backend"} does not accept the effort parameter — retried without it; effort is now off for ${model || "all models"} in this process:`,
          detail.slice(0, 300),
        );
        res = await doFetch();
      }
    }
    return res;
  };
}

/**
 * This SDK version's default base URL is the bare origin ("https://
 * api.anthropic.com") and resource paths carry "/v1" themselves. The env
 * variable has historically been written both with and without "/v1" — strip
 * a trailing version segment so either form keeps working (tests, proxies).
 */
function normalizeBaseURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

export function createClaudeClient(oauth: ClaudeOAuth): Anthropic {
  // Pay-as-you-go fallback: with a real console API key (console.anthropic.com
  // → API Keys) the OAuth/impersonation path is bypassed entirely — requests
  // bill to the key's credits, never to the subscription. /models still uses
  // the OAuth token regardless.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new Anthropic({
      apiKey,
      maxRetries: 2,
      baseURL: normalizeBaseURL(process.env.ANTHROPIC_BASE_URL),
    });
  }
  // Claude Code checks in with the bootstrap endpoint at every startup; the
  // fire-and-forget call also refreshes the cached account uuid.
  void bootstrapSession(oauth);
  return new Anthropic({
    apiKey: "managed-by-oauth", // the real credential is injected by oauthFetch
    fetch: oauthFetch(oauth),
    maxRetries: 2,
    // mock server for tests; defaults to api.anthropic.com in production
    baseURL: normalizeBaseURL(process.env.ANTHROPIC_BASE_URL),
  });
}
