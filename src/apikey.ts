/**
 * API key resolution for the HTTP server.
 *
 *   1. AGENT_API_KEY env var                      -> source "env"
 *   2. <data dir>/api-key (created earlier)       -> source "file"
 *   3. neither: generate one, save it (mode 0600) -> source "generated"
 *
 * Saving the generated key keeps it stable across restarts, so the
 * orchestrator does not have to be reconfigured every time the server starts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "./paths.js";

export const MIN_KEY_LENGTH = 16;

export interface ResolvedKey {
  key: string;
  source: "env" | "file" | "generated";
  /** Where the key is stored (file / generated). */
  file?: string;
}

export function apiKeyFile(): string {
  return path.join(dataDir(), "api-key");
}

export function generateApiKey(): string {
  return "wf_" + crypto.randomBytes(24).toString("base64url");
}

/** Throws if AGENT_API_KEY is set but too short. */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): ResolvedKey {
  if (env.AGENT_API_KEY) {
    if (env.AGENT_API_KEY.length < MIN_KEY_LENGTH) {
      throw new Error(
        `AGENT_API_KEY is too short (${env.AGENT_API_KEY.length} chars, need at least ${MIN_KEY_LENGTH}). ` +
          "Unset it and WrongForge will generate a strong key for you.",
      );
    }
    return { key: env.AGENT_API_KEY, source: "env" };
  }

  const file = apiKeyFile();
  try {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (stored.length >= MIN_KEY_LENGTH) return { key: stored, source: "file", file };
  } catch {
    /* none yet */
  }

  const key = generateApiKey();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  return { key, source: "generated", file };
}

/** `wf_AbCd…WxYz` — for places where the full key must not appear. */
export function maskKey(key: string): string {
  return key.length <= 10 ? "****" : `${key.slice(0, 5)}…${key.slice(-4)}`;
}

// ------------------------------------------------------------------- clients

/**
 * Multiple orchestrators (several WrongStack instances) can share one
 * WrongForge server; without per-client keys they would all hold the same
 * credential and see — and be able to cancel — each other's tasks and
 * sessions. A client key gives each of them their own identity: tasks are
 * stamped with the authenticated client, sessions are owned by their creator,
 * list/event/cancel routes are scoped to the caller, and the task queue
 * reserves slots across clients (see TaskManager). The plain single key
 * (`AGENT_API_KEY` / the api-key file) stays valid and maps to the client
 * "default", which keeps its admin view (sees every client) — so existing
 * single-orchestrator setups are untouched.
 */

export const DEFAULT_CLIENT = "default";
export const CLIENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export interface ClientKeys {
  /** Every valid key (the default key included) -> client name. */
  byKey: Map<string, string>;
  /** The admin/default key — the one resolveApiKey() produced. */
  defaultKey: string;
  /** Where the extra named keys came from ("env" | "file"). */
  source: "env" | "file" | "none";
}

function parseClientKeysMap(raw: Record<string, unknown>, source: "env" | "file"): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const [name, key] of Object.entries(raw)) {
    if (!CLIENT_NAME_RE.test(name)) throw new Error(`client name "${name}" must match ${CLIENT_NAME_RE.source}`);
    if (name === DEFAULT_CLIENT) throw new Error(`"${DEFAULT_CLIENT}" is reserved for the single API key (AGENT_API_KEY / api-key file) — pick another client name`);
    if (typeof key !== "string" || key.length < MIN_KEY_LENGTH) {
      throw new Error(`client "${name}" key is too short (need at least ${MIN_KEY_LENGTH} chars)`);
    }
    if (byKey.has(key)) throw new Error(`the same key is assigned to two clients (one of them: "${name}")`);
    byKey.set(key, name);
  }
  return byKey;
}

/**
 * Layers named client keys over the default key:
 *   1. `AGENT_API_KEYS` env ("name=key,name=key"; keys are base64url, so the
 *      first "=" separates each pair)
 *   2. `<data dir>/api-keys.json` ({ "name": "wf_…" })
 * Invalid config throws at startup (fail closed, like a short AGENT_API_KEY) —
 * including a key colliding with the default key or another client's: silently
 * remapping one would quietly change who holds the admin view.
 */
export function resolveClientKeys(defaultKey: string, env: NodeJS.ProcessEnv = process.env, keysFile?: string): ClientKeys {
  const byKey = new Map<string, string>([[defaultKey, DEFAULT_CLIENT]]);
  const add = (name: string, key: string): void => {
    if (byKey.has(key)) throw new Error(`client "${name}" key collides with an existing key (${byKey.get(key)})`);
    byKey.set(key, name);
  };
  let source: ClientKeys["source"] = "none";
  const rawEnv = env.AGENT_API_KEYS?.trim();
  if (rawEnv) {
    const map: Record<string, string> = {};
    for (const pair of rawEnv.split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`AGENT_API_KEYS: "${pair.trim()}" is not name=key`);
      map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    for (const [k, v] of parseClientKeysMap(map, "env")) add(v, k);
    source = "env";
  } else if (keysFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keysFile, "utf8")) as Record<string, unknown>;
      for (const [k, v] of parseClientKeysMap(parsed, "file")) add(v, k);
      source = "file";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return { byKey, defaultKey, source };
}

export function clientKeysFile(): string {
  return path.join(dataDir(), "api-keys.json");
}

