/**
 * Live model list — GET {api}/v1/models (Anthropic Models API).
 * Uses the same OAuth signing scheme: Bearer + anthropic-beta + anthropic-version.
 * This keeps the app correct even when the static list goes stale.
 */

import type { ClaudeOAuth } from "./oauth.js";
import { PROTOCOL } from "./oauth.js";

export interface ModelEntry {
  id: string;
  display_name: string;
  created_at: string;
}

function apiBase(): string {
  // same convention as the provider: ANTHROPIC_BASE_URL may include "/v1"
  const raw = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function fetchModelList(
  oauth: ClaudeOAuth,
): Promise<{ ok: true; models: ModelEntry[] } | { ok: false; error: string }> {
  try {
    const token = await oauth.getAccessToken();
    const models: ModelEntry[] = [];
    let after: string | undefined;
    // pagination: has_more / first_id-last_id
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${apiBase()}/v1/models`);
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after_id", after);
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": PROTOCOL.oauthBeta,
          "anthropic-version": PROTOCOL.anthropicVersion,
        },
      });
      if (res.status !== 200) {
        const text = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const json: any = await res.json();
      for (const m of json.data ?? []) {
        if (m?.type === "model" && typeof m.id === "string") {
          models.push({
            id: m.id,
            display_name: m.display_name ?? m.id,
            created_at: m.created_at ?? "",
          });
        }
      }
      if (!json.has_more || !json.last_id) break;
      after = json.last_id;
    }
    // newest first
    models.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
