/**
 * MCP server configuration — a JSON file in the Claude Code `mcpServers`
 * format, so existing configs can be pasted in as they are:
 *
 *   {
 *     "mcpServers": {
 *       "github":     { "type": "http", "url": "https://…/mcp", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
 *       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/work"] }
 *     }
 *   }
 *
 * Location: `$WRONGFORGE_MCP_CONFIG`, else `<data dir>/mcp.json` (mode 0600).
 *
 * Secrets: values may reference environment variables as `${NAME}` or
 * `${NAME:-default}`; they are expanded when a connection is opened, so the
 * file itself need not contain a token. Everything shown to the model or
 * returned by the API goes through `redactSpec`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "../paths.js";

export type McpTransportType = "http" | "sse" | "stdio";

/** A server entry as written in the file (only these keys are kept). */
export interface McpServerSpec {
  /** Inferred when missing: `command` -> stdio, `url` -> http. */
  type?: McpTransportType;
  // http / sse
  url?: string;
  headers?: Record<string, string>;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // WrongForge extras (all optional)
  /** false = keep the entry but do not connect (default true). */
  enabled?: boolean;
  /** true (default): the server's tools are exposed one by one, with schemas, at task start. false: reachable only via mcp_tools / mcp_call. */
  eager?: boolean;
  /** true: a task that selects this server fails if it cannot connect (default false: it is skipped with a warning). */
  required?: boolean;
  /** Free-text note for humans and the agent. */
  description?: string;
  /** Only expose tools matching these names (`*` suffix wildcard). */
  allow?: string[];
  /** Never expose tools matching these names. */
  deny?: string[];
  /** Per tool call timeout (default 120 000 ms). */
  timeout_ms?: number;
  /** Connect + initialize timeout (default 30 000 ms). */
  startup_timeout_ms?: number;
  /** true: skip the modern `server/discover` probe and initialize directly (very old servers). */
  legacy_init?: boolean;
}

export interface NormalizedSpec extends McpServerSpec {
  type: McpTransportType;
  enabled: boolean;
  eager: boolean;
  required: boolean;
  timeout_ms: number;
  startup_timeout_ms: number;
}

export class McpConfigError extends Error {}

export const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STARTUP_MS = 30_000;
const KNOWN_KEYS = new Set([
  "type", "url", "headers", "command", "args", "env", "cwd",
  "enabled", "eager", "required", "description", "allow", "deny", "timeout_ms", "startup_timeout_ms", "legacy_init",
]);

export function isValidServerName(name: unknown): name is string {
  return typeof name === "string" && SERVER_NAME_RE.test(name);
}

const isStringMap = (v: unknown, max: number): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.keys(v).length <= max &&
  Object.values(v).every((x) => typeof x === "string" && x.length <= 8192);

/**
 * Validates one entry. Returns the cleaned entry (only known keys, `type`
 * filled in) — that is what gets stored. Throws McpConfigError.
 */
export function validateSpec(name: string, raw: unknown): McpServerSpec {
  const bad = (m: string): never => {
    throw new McpConfigError(`server "${name}": ${m}`);
  };
  if (!isValidServerName(name)) {
    throw new McpConfigError(`invalid server name "${name}" (use letters, digits, "_" or "-", max 32 chars, starting with a letter or digit)`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("the entry must be an object");
  const r = raw as Record<string, unknown>;

  const type = (r.type ?? (r.command ? "stdio" : r.url ? "http" : undefined)) as McpTransportType | undefined;
  if (type !== "http" && type !== "sse" && type !== "stdio") {
    return bad('cannot tell the transport: give "url" (http/sse) or "command" (stdio), or set "type"');
  }
  const out: McpServerSpec = { type };

  if (type === "stdio") {
    if (typeof r.command !== "string" || !r.command.trim()) bad('stdio servers need a "command"');
    out.command = r.command as string;
    if (r.args !== undefined) {
      if (!Array.isArray(r.args) || r.args.length > 100 || r.args.some((a) => typeof a !== "string")) bad('"args" must be an array of strings');
      out.args = r.args as string[];
    }
    if (r.env !== undefined) {
      if (!isStringMap(r.env, 100)) bad('"env" must be an object of strings');
      out.env = r.env as Record<string, string>;
    }
    if (r.cwd !== undefined) {
      if (typeof r.cwd !== "string") bad('"cwd" must be a string');
      out.cwd = r.cwd as string;
    }
    if (r.url !== undefined || r.headers !== undefined) bad('"url"/"headers" do not apply to stdio servers');
  } else {
    if (typeof r.url !== "string") bad(`${type} servers need a "url"`);
    // `${VAR}` placeholders are allowed inside the url, so validate a placeholder-free copy
    try {
      const u = new URL((r.url as string).replace(/\$\{[^}]*\}/g, "x"));
      if (u.protocol !== "http:" && u.protocol !== "https:") bad('"url" must be http(s)');
    } catch (e) {
      if (e instanceof McpConfigError) throw e;
      bad('"url" is not a valid URL');
    }
    out.url = r.url as string;
    if (r.headers !== undefined) {
      if (!isStringMap(r.headers, 30)) bad('"headers" must be an object of strings');
      out.headers = r.headers as Record<string, string>;
    }
    if (r.command !== undefined || r.args !== undefined || r.env !== undefined) bad('"command"/"args"/"env" do not apply to http/sse servers');
  }

  for (const k of ["enabled", "eager", "required", "legacy_init"] as const) {
    if (r[k] !== undefined) {
      if (typeof r[k] !== "boolean") bad(`"${k}" must be true or false`);
      out[k] = r[k] as boolean;
    }
  }
  if (r.description !== undefined) {
    if (typeof r.description !== "string") bad('"description" must be a string');
    out.description = (r.description as string).slice(0, 500);
  }
  for (const k of ["allow", "deny"] as const) {
    if (r[k] !== undefined) {
      if (!Array.isArray(r[k]) || (r[k] as unknown[]).length > 200 || (r[k] as unknown[]).some((x) => typeof x !== "string")) bad(`"${k}" must be an array of strings`);
      out[k] = r[k] as string[];
    }
  }
  for (const k of ["timeout_ms", "startup_timeout_ms"] as const) {
    if (r[k] !== undefined) {
      const v = r[k];
      if (!Number.isInteger(v) || (v as number) < 1000 || (v as number) > 3_600_000) bad(`"${k}" must be an integer between 1000 and 3600000`);
      out[k] = v as number;
    }
  }
  return out;
}

/** Fills in defaults. */
export function normalizeSpec(spec: McpServerSpec): NormalizedSpec {
  return {
    ...spec,
    type: spec.type as McpTransportType,
    enabled: spec.enabled ?? true,
    eager: spec.eager ?? true,
    required: spec.required ?? false,
    timeout_ms: spec.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    startup_timeout_ms: spec.startup_timeout_ms ?? DEFAULT_STARTUP_MS,
  };
}

// ------------------------------------------------------------------ secrets

/**
 * Expands `${NAME}` / `${NAME:-default}` from `env`. Throws McpConfigError
 * when a variable is missing and has no default.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, key: string, dflt?: string) => {
    const v = env[key];
    if (v !== undefined && v !== "") return v;
    if (dflt !== undefined) return dflt;
    throw new McpConfigError(`${where}: environment variable ${key} is not set (referenced as \${${key}})`);
  });
}

/** A copy of the spec with every secret-looking value replaced (for the model, the API and logs). */
export function redactSpec(spec: McpServerSpec): McpServerSpec {
  const mask = (m?: Record<string, string>): Record<string, string> | undefined =>
    m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.includes("${") ? v : "[redacted]"]));
  const out: McpServerSpec = { ...spec };
  if (out.headers) out.headers = mask(out.headers);
  if (out.env) out.env = mask(out.env);
  if (out.url) {
    try {
      const u = new URL(out.url.replace(/\$\{[^}]*\}/g, "x"));
      if (u.username || u.password || u.search) {
        out.url = `${u.origin}${u.pathname}${u.search ? "?[redacted]" : ""}`;
      }
    } catch {
      /* keep as is */
    }
  }
  return out;
}

// -------------------------------------------------------------------- store

export interface ImportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  invalid: { name: string; error: string }[];
}

export class McpStore {
  private cache: { mtimeMs: number; size: number; raw: Record<string, unknown> } | null = null;

  constructor(readonly file: string) {}

  static defaultFile(env: NodeJS.ProcessEnv = process.env): string {
    return env.WRONGFORGE_MCP_CONFIG || path.join(dataDir(), "mcp.json");
  }

  /** Whole file as parsed JSON ({} if missing). Throws McpConfigError on broken JSON. */
  private readRaw(): Record<string, unknown> {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return {};
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.raw;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      throw new McpConfigError(`${this.file} is not valid JSON: ${(e as Error).message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new McpConfigError(`${this.file} must contain a JSON object`);
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, raw };
    return raw;
  }

  private servers(raw: Record<string, unknown>): Record<string, unknown> {
    const s = raw.mcpServers;
    return typeof s === "object" && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  }

  /** All valid servers (entries that fail validation are reported in `errors`, never thrown). */
  readAll(): { servers: Map<string, NormalizedSpec>; errors: { name: string; error: string }[] } {
    const servers = new Map<string, NormalizedSpec>();
    const errors: { name: string; error: string }[] = [];
    for (const [name, entry] of Object.entries(this.servers(this.readRaw()))) {
      try {
        servers.set(name, normalizeSpec(validateSpec(name, entry)));
      } catch (e) {
        errors.push({ name, error: (e as Error).message });
      }
    }
    return { servers, errors };
  }

  list(): { name: string; spec: NormalizedSpec }[] {
    return [...this.readAll().servers].map(([name, spec]) => ({ name, spec }));
  }

  get(name: string): NormalizedSpec | undefined {
    return this.readAll().servers.get(name);
  }

  /** Adds or replaces a server. Returns the stored (cleaned) entry and whether it existed. */
  put(name: string, spec: unknown): { spec: NormalizedSpec; existed: boolean } {
    const clean = validateSpec(name, spec);
    const raw = { ...this.readRaw() };
    const servers = { ...this.servers(raw) };
    const existed = name in servers;
    servers[name] = clean;
    raw.mcpServers = servers;
    this.write(raw);
    return { spec: normalizeSpec(clean), existed };
  }

  remove(name: string): boolean {
    const raw = { ...this.readRaw() };
    const servers = { ...this.servers(raw) };
    if (!(name in servers)) return false;
    delete servers[name];
    raw.mcpServers = servers;
    this.write(raw);
    return true;
  }

  setEnabled(name: string, enabled: boolean): NormalizedSpec | undefined {
    const cur = this.get(name);
    if (!cur) return undefined;
    const { spec } = this.put(name, { ...stripDefaults(cur), enabled });
    return spec;
  }

  /**
   * Imports entries from a Claude Code style document (`{ mcpServers: {…} }`,
   * or the map itself). Existing names are skipped unless `overwrite`.
   */
  import(doc: unknown, opts: { overwrite?: boolean } = {}): ImportResult {
    const res: ImportResult = { added: [], updated: [], skipped: [], invalid: [] };
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      throw new McpConfigError("the import document must be a JSON object");
    }
    const d = doc as Record<string, unknown>;
    const map = (typeof d.mcpServers === "object" && d.mcpServers !== null ? d.mcpServers : d) as Record<string, unknown>;
    const existing = this.readAll().servers;
    for (const [name, entry] of Object.entries(map)) {
      try {
        const clean = validateSpec(name, entry);
        if (existing.has(name) && !opts.overwrite) {
          res.skipped.push(name);
          continue;
        }
        const raw = { ...this.readRaw() };
        const servers = { ...this.servers(raw), [name]: clean };
        raw.mcpServers = servers;
        this.write(raw);
        (existing.has(name) ? res.updated : res.added).push(name);
        existing.set(name, normalizeSpec(clean));
      } catch (e) {
        res.invalid.push({ name, error: (e as Error).message });
      }
    }
    return res;
  }

  private write(raw: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }
}

/** Removes the defaults added by normalizeSpec so a re-saved entry stays minimal. */
function stripDefaults(s: NormalizedSpec): McpServerSpec {
  const out: McpServerSpec = {};
  for (const [k, v] of Object.entries(s)) if (KNOWN_KEYS.has(k) && v !== undefined) (out as Record<string, unknown>)[k] = v;
  if (out.enabled === true) delete out.enabled;
  if (out.eager === true) delete out.eager;
  if (out.required === false) delete out.required;
  if (out.timeout_ms === DEFAULT_TIMEOUT_MS) delete out.timeout_ms;
  if (out.startup_timeout_ms === DEFAULT_STARTUP_MS) delete out.startup_timeout_ms;
  return out;
}
