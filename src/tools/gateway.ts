/**
 * Tool gateway — tools WrongForge does not have itself, provided by the
 * orchestrator (WrongStack) over HTTP and presented to the model as if they
 * were native tools.
 *
 *   discovery   GET  {url}{list_path}            -> { tools: [{ name, description, input_schema }] }
 *   call        POST {url}{call_path}            <- { tool, input, task_id, session_id, call_id, workdir }
 *                                                -> { ok, output | error }   (or any JSON = the output)
 *
 * Instead of discovery, a task can pass the definitions inline (`tools`).
 * See docs/TOOL-GATEWAY.md for the full contract.
 *
 * Design notes
 *  - Exposed names are `<name_prefix><name>` (default `wstack_`), sorted, so the
 *    tool list — part of the prompt-cache prefix — is byte-stable between tasks
 *    as long as the orchestrator's tool set does not change.
 *  - Failures of a call never throw into the agent loop: the model gets
 *    `{ ok:false, error }` and can react, exactly like with native tools.
 *  - Token and custom headers live in memory only; they are never persisted
 *    or logged.
 */

import * as crypto from "node:crypto";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { Logger } from "../log.js";
import { truncateMiddle } from "./util.js";

export interface ExternalToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface GatewaySpec {
  /** Base URL of the orchestrator's tool API, e.g. http://127.0.0.1:7777 */
  url: string;
  /** Sent as `Authorization: Bearer <token>`. Memory only. */
  token?: string;
  /** Extra request headers. Memory only (values may be secret). */
  headers?: Record<string, string>;
  /** Discovery path (default `/tools`). */
  list_path?: string;
  /** Call path; `{name}` is replaced by the tool name (default `/tools/{name}/call`). */
  call_path?: string;
  /** Inline definitions — when given, no discovery request is made. */
  tools?: ExternalToolDef[];
  /** Only expose tools matching one of these names (`*` suffix wildcard allowed). */
  allow?: string[];
  /** Never expose tools matching these names. */
  deny?: string[];
  /** Prefix for the exposed names (default `wstack_`; `[A-Za-z0-9_]{0,20}`). */
  name_prefix?: string;
  /** Per-call timeout in ms (default 120 000, max 600 000). */
  call_timeout_ms?: number;
  /** true: if discovery fails, run the task without these tools instead of failing it. */
  optional?: boolean;
}

/** The persistable, secret-free view of a gateway. */
export interface GatewayInfo {
  url: string;
  list_path: string;
  call_path: string;
  name_prefix: string;
  call_timeout_ms: number;
  optional: boolean;
  inline: boolean;
  allow?: string[];
  deny?: string[];
  has_token: boolean;
  header_names: string[];
  /** Exposed tool names — filled in once discovery has run. */
  tool_names?: string[];
}

export interface LoadedDef {
  /** Name the model sees. */
  exposed: string;
  /** Name the orchestrator knows. */
  remote: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface LoadedGateway {
  tools: ToolSet;
  defs: LoadedDef[];
  /** Stable fingerprint of the exposed tool set (changes => prompt cache restarts). */
  hash: string;
  /** Discovery answered from the in-memory cache. */
  cached: boolean;
  warnings: string[];
}

const DEFAULT_LIST_PATH = "/tools";
const DEFAULT_CALL_PATH = "/tools/{name}/call";
const DEFAULT_PREFIX = "wstack_";
const DEFAULT_CALL_TIMEOUT = 120_000;
const MAX_CALL_TIMEOUT = 600_000;
const MAX_TOOLS = 200;
const MAX_OUTPUT_CHARS = 60_000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const NAME_RE = /^[A-Za-z0-9_]{0,20}$/;

export class GatewayError extends Error {
  constructor(
    readonly code: "invalid_gateway" | "tool_gateway_unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** Hosts a gateway URL may point to. `*` allows any. Default: loopback only. */
export function allowedGatewayHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const v = env.WRONGFORGE_GATEWAY_ALLOWED_HOSTS?.trim();
  return v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : LOOPBACK_HOSTS;
}

const matches = (patterns: string[], name: string): boolean =>
  patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));

/** Validates a gateway spec from a task request; throws GatewayError(invalid_gateway). */
export function validateGatewaySpec(spec: unknown, allowedHosts: string[]): GatewaySpec {
  const bad = (m: string): never => {
    throw new GatewayError("invalid_gateway", m);
  };
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) bad("`gateway` must be an object");
  const g = spec as GatewaySpec;

  if (typeof g.url !== "string") bad("`gateway.url` is required");
  let u: URL;
  try {
    u = new URL(g.url);
  } catch {
    return bad("`gateway.url` is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") bad("`gateway.url` must be http(s)");
  if (!allowedHosts.includes("*") && !allowedHosts.includes(u.hostname.toLowerCase())) {
    bad(`gateway host "${u.hostname}" is not allowed (set WRONGFORGE_GATEWAY_ALLOWED_HOSTS to permit it)`);
  }
  for (const k of ["list_path", "call_path"] as const) {
    if (g[k] !== undefined && (typeof g[k] !== "string" || !g[k]!.startsWith("/"))) bad(`\`gateway.${k}\` must be a path starting with "/"`);
  }
  if (g.token !== undefined && (typeof g.token !== "string" || g.token.length > 4096)) bad("`gateway.token` must be a string");
  if (g.headers !== undefined) {
    if (typeof g.headers !== "object" || g.headers === null || Array.isArray(g.headers)) bad("`gateway.headers` must be an object of strings");
    const e = Object.entries(g.headers);
    if (e.length > 20) bad("`gateway.headers` may have at most 20 entries");
    for (const [k, v] of e) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 4096) bad(`invalid gateway header: ${k}`);
    }
  }
  for (const k of ["allow", "deny"] as const) {
    const v = g[k];
    if (v !== undefined && (!Array.isArray(v) || v.length > 100 || v.some((x) => typeof x !== "string"))) bad(`\`gateway.${k}\` must be an array of up to 100 strings`);
  }
  if (g.name_prefix !== undefined && (typeof g.name_prefix !== "string" || !NAME_RE.test(g.name_prefix))) {
    bad("`gateway.name_prefix` must match [A-Za-z0-9_]{0,20}");
  }
  if (g.call_timeout_ms !== undefined && (!Number.isInteger(g.call_timeout_ms) || g.call_timeout_ms < 1000 || g.call_timeout_ms > MAX_CALL_TIMEOUT)) {
    bad(`\`gateway.call_timeout_ms\` must be an integer 1000-${MAX_CALL_TIMEOUT}`);
  }
  if (g.optional !== undefined && typeof g.optional !== "boolean") bad("`gateway.optional` must be a boolean");
  if (g.tools !== undefined) {
    if (!Array.isArray(g.tools) || g.tools.length > MAX_TOOLS) bad(`\`gateway.tools\` must be an array of up to ${MAX_TOOLS} tool definitions`);
    for (const t of g.tools) {
      if (typeof t !== "object" || t === null || typeof t.name !== "string" || !t.name) bad("every inline tool needs a `name`");
      if (typeof t.input_schema !== "object" || t.input_schema === null) bad(`inline tool "${t.name}" needs an \`input_schema\` object`);
    }
  }
  return g;
}

/** Secret-free description of a validated spec (what the task record stores). */
export function describeGateway(g: GatewaySpec): GatewayInfo {
  return {
    url: g.url,
    list_path: g.list_path ?? DEFAULT_LIST_PATH,
    call_path: g.call_path ?? DEFAULT_CALL_PATH,
    name_prefix: g.name_prefix ?? DEFAULT_PREFIX,
    call_timeout_ms: g.call_timeout_ms ?? DEFAULT_CALL_TIMEOUT,
    optional: g.optional ?? false,
    inline: Array.isArray(g.tools),
    ...(g.allow ? { allow: g.allow } : {}),
    ...(g.deny ? { deny: g.deny } : {}),
    has_token: Boolean(g.token),
    header_names: Object.keys(g.headers ?? {}),
  };
}

function authHeaders(g: GatewaySpec): Record<string, string> {
  return { ...(g.headers ?? {}), ...(g.token ? { Authorization: `Bearer ${g.token}` } : {}) };
}

const sanitizeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** Turns raw definitions into the exposed, sorted, filtered set. */
export function normalizeDefs(
  raw: unknown[],
  g: GatewaySpec,
  reserved: ReadonlySet<string>,
): { defs: LoadedDef[]; warnings: string[] } {
  const warnings: string[] = [];
  const prefix = g.name_prefix ?? DEFAULT_PREFIX;
  const seen = new Set<string>();
  const defs: LoadedDef[] = [];

  for (const item of raw) {
    const t = item as Record<string, any>;
    if (!t || typeof t.name !== "string" || !t.name) {
      warnings.push("skipped a tool definition without a name");
      continue;
    }
    if (g.allow?.length && !matches(g.allow, t.name)) continue;
    if (g.deny?.length && matches(g.deny, t.name)) continue;

    let schema = (t.input_schema ?? t.inputSchema ?? t.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      warnings.push(`skipped "${t.name}": input schema is not an object`);
      continue;
    }
    if (schema.type === undefined) schema = { type: "object", ...schema };
    if (schema.type !== "object") {
      warnings.push(`skipped "${t.name}": the input schema's top-level type must be "object"`);
      continue;
    }
    if (schema.properties === undefined) schema = { ...schema, properties: {} };

    const exposed = sanitizeName(`${prefix}${t.name}`).slice(0, 64);
    if (reserved.has(exposed)) {
      warnings.push(`skipped "${t.name}": the name "${exposed}" collides with a built-in tool (use another name_prefix)`);
      continue;
    }
    if (seen.has(exposed)) {
      warnings.push(`skipped a duplicate of "${exposed}"`);
      continue;
    }
    seen.add(exposed);
    defs.push({
      exposed,
      remote: t.name,
      description: String(t.description ?? `Tool "${t.name}" provided by the orchestrator.`).slice(0, 4000),
      schema,
    });
  }

  defs.sort((a, b) => a.exposed.localeCompare(b.exposed));
  if (defs.length > MAX_TOOLS) {
    warnings.push(`only the first ${MAX_TOOLS} tools are exposed (${defs.length} found)`);
    defs.length = MAX_TOOLS;
  }
  return { defs, warnings };
}

/** Stable fingerprint of a tool set. */
export function toolsHash(defs: LoadedDef[]): string {
  const canon = JSON.stringify(defs.map((d) => [d.exposed, d.description, d.schema]));
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

export interface CallContext {
  taskId: string;
  sessionId: string;
  workdir: string;
}

export interface GatewayRegistryOptions {
  /** Names the gateway tools must not shadow (the built-in tools). */
  reservedNames: ReadonlySet<string>;
  logger?: Logger;
  /** How long a discovery answer is reused (default 30 000 ms; 0 disables). */
  discoveryTtlMs?: number;
  /** Discovery request timeout (default 10 000 ms). */
  discoveryTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GatewayRegistry {
  private cache = new Map<string, { at: number; raw: unknown[] }>();
  private readonly ttl: number;
  private readonly discoveryTimeout: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly o: GatewayRegistryOptions) {
    this.ttl = o.discoveryTtlMs ?? Number(process.env.WRONGFORGE_GATEWAY_DISCOVERY_TTL_MS ?? 30_000);
    this.discoveryTimeout = o.discoveryTimeoutMs ?? 10_000;
    this.doFetch = o.fetchImpl ?? fetch;
  }

  /** Discovers (or takes inline) the tools and builds executable AI SDK tools. */
  async load(g: GatewaySpec, ctx: CallContext, signal?: AbortSignal): Promise<LoadedGateway> {
    let raw: unknown[];
    let cached = false;
    if (g.tools) {
      raw = g.tools;
    } else {
      const key = crypto
        .createHash("sha256")
        .update(JSON.stringify([g.url, g.list_path, authHeaders(g)]))
        .digest("hex");
      const hit = this.cache.get(key);
      if (hit && this.ttl > 0 && Date.now() - hit.at < this.ttl) {
        raw = hit.raw;
        cached = true;
      } else {
        raw = await this.discover(g, signal);
        this.cache.set(key, { at: Date.now(), raw });
      }
    }
    const { defs, warnings } = normalizeDefs(raw, g, this.o.reservedNames);
    return { tools: this.buildTools(defs, g, ctx), defs, hash: toolsHash(defs), cached, warnings };
  }

  private async discover(g: GatewaySpec, signal?: AbortSignal): Promise<unknown[]> {
    const url = g.url.replace(/\/+$/, "") + (g.list_path ?? DEFAULT_LIST_PATH);
    const fail = (m: string): never => {
      throw new GatewayError("tool_gateway_unavailable", `tool discovery at ${url} failed: ${m}`);
    };
    let res: Response;
    try {
      res = await this.doFetch(url, {
        headers: { Accept: "application/json", ...authHeaders(g) },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.discoveryTimeout)])
          : AbortSignal.timeout(this.discoveryTimeout),
      });
    } catch (e) {
      return fail((e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message);
    }
    if (!res.ok) return fail(`HTTP ${res.status}`);
    let body: any;
    try {
      body = await res.json();
    } catch {
      return fail("the response is not JSON");
    }
    const list = Array.isArray(body) ? body : body?.tools;
    if (!Array.isArray(list)) return fail('expected {"tools":[…]} or a JSON array');
    return list;
  }

  private buildTools(defs: LoadedDef[], g: GatewaySpec, ctx: CallContext): ToolSet {
    const tools: ToolSet = {};
    for (const d of defs) {
      tools[d.exposed] = dynamicTool({
        description: d.description,
        inputSchema: jsonSchema(d.schema as any),
        execute: (input, options) => this.call(d, g, ctx, input, options?.toolCallId, options?.abortSignal),
      });
    }
    return tools;
  }

  /** Executes one remote tool call. Never throws: errors become `{ ok:false, error }`. */
  async call(
    d: LoadedDef,
    g: GatewaySpec,
    ctx: CallContext,
    input: unknown,
    callId?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = g.call_timeout_ms ?? DEFAULT_CALL_TIMEOUT;
    const url =
      g.url.replace(/\/+$/, "") + (g.call_path ?? DEFAULT_CALL_PATH).replace("{name}", encodeURIComponent(d.remote));
    const started = Date.now();
    const log = (ok: boolean, extra: Record<string, unknown>): void =>
      this.o.logger?.info("gateway.call", {
        task_id: ctx.taskId, tool: d.remote, call_id: callId, ok, duration_ms: Date.now() - started, ...extra,
      });

    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-WrongForge-Task": ctx.taskId,
          "X-WrongForge-Session": ctx.sessionId,
          ...(callId ? { "X-WrongForge-Tool-Call": callId } : {}),
          ...authHeaders(g),
        },
        body: JSON.stringify({
          tool: d.remote,
          input,
          task_id: ctx.taskId,
          session_id: ctx.sessionId,
          call_id: callId,
          workdir: ctx.workdir,
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      const msg =
        err.name === "TimeoutError"
          ? `the call timed out after ${timeoutMs} ms`
          : signal?.aborted
            ? "the call was cancelled"
            : `tool gateway unreachable: ${err.message}`;
      log(false, { error: msg });
      return { ok: false, error: msg };
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const error = `tool gateway answered HTTP ${res.status}: ${truncateMiddle(text, 1500) || res.statusText}`;
      log(false, { status: res.status });
      return { ok: false, error };
    }

    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* plain text output */
    }

    const wrapped =
      typeof body === "object" && body !== null && !Array.isArray(body) && typeof (body as any).ok === "boolean"
        ? (body as Record<string, unknown>)
        : { ok: true, output: body };

    const serialized = JSON.stringify(wrapped);
    log(wrapped.ok === true, { status: res.status, bytes: serialized.length });
    if (serialized.length <= MAX_OUTPUT_CHARS) return wrapped;
    return {
      ok: wrapped.ok,
      truncated: true,
      note: `the answer was ${serialized.length} chars; only the beginning and end are shown`,
      output: truncateMiddle(serialized, MAX_OUTPUT_CHARS),
    };
  }
}
