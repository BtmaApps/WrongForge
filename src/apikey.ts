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
