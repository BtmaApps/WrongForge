/**
 * Plan-usage state from the subscription backend.
 *
 * GET /api/oauth/usage — the same endpoint Claude Code's /usage command reads
 * (found in the carved 2.1.300 modules, mod-0422; live schema verified
 * 2026-10-15, re/notes/findings.md). Returns the 5-hour session window, the
 * weekly limit and the extra-usage state. Cached in memory for 5 minutes,
 * exactly like the real client.
 */

import type { ClaudeOAuth } from "./oauth.js";

export interface UsageWindow {
  /** Percent of the window consumed (0-100). */
  percent: number | null;
  /** When the window resets (ISO string). */
  resetsAt: string | null;
  isActive: boolean;
}

export interface PlanUsage {
  /** The rolling 5-hour session window. */
  fiveHour: UsageWindow;
  /** The weekly limit (active window), null when the plan has none. */
  weekly: UsageWindow | null;
  /** Extra usage (pay-as-you-go credits) state. */
  extraUsage: {
    enabled: boolean;
    usedCredits: number | null;
    monthlyLimit: number | null;
    utilization: number | null;
  };
  /** Raw response for anything not projected above. */
  raw: unknown;
}

interface UsageLimit {
  kind?: string;
  group?: string;
  percent?: number | null;
  resets_at?: string | null;
  is_active?: boolean | null;
}

interface RawUsage {
  five_hour?: { utilization?: number | null; resets_at?: string | null; locked_reason?: string | null } | null;
  limits?: UsageLimit[] | null;
  extra_usage?: {
    is_enabled?: boolean | null;
    used_credits?: number | null;
    monthly_limit?: number | null;
    utilization?: number | null;
  } | null;
}

const CACHE_MS = 300_000; // same re-read interval as Claude Code
let cache: { at: number; value: PlanUsage } | null = null;

function windowOf(limit: UsageLimit | undefined | null): UsageWindow | null {
  if (!limit) return null;
  return {
    percent: typeof limit.percent === "number" ? limit.percent : null,
    resetsAt: typeof limit.resets_at === "string" ? limit.resets_at : null,
    isActive: limit.is_active === true,
  };
}

/** Same-origin rule as the model client: tests/proxies may point elsewhere. */
function usageUrl(): string {
  const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/, "");
  return `${base}/api/oauth/usage`;
}

/** Fetches (and caches) the plan usage. Never throws: errors return null. */
export async function fetchPlanUsage(
  oauth: ClaudeOAuth,
  opts: { force?: boolean } = {},
): Promise<PlanUsage | null> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const token = await oauth.getAccessToken();
    const res = await fetch(usageUrl(), {
      headers: {
        "User-Agent": "claude-cli/2.1.300 (external, sdk-cli)",
        "x-app": "cli",
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as RawUsage;
    const limits = raw.limits ?? [];
    const session = limits.find((l) => l.kind === "session" || l.group === "session");
    const weekly =
      limits.find((l) => (l.kind ?? l.group ?? "").startsWith("weekly") && l.is_active) ??
      limits.find((l) => (l.kind ?? l.group ?? "").startsWith("weekly"));
    const value: PlanUsage = {
      fiveHour:
        windowOf(session) ?? {
          percent: raw.five_hour?.utilization ?? null,
          resetsAt: raw.five_hour?.resets_at ?? null,
          isActive: true,
        },
      weekly: windowOf(weekly),
      extraUsage: {
        enabled: raw.extra_usage?.is_enabled === true,
        usedCredits: raw.extra_usage?.used_credits ?? null,
        monthlyLimit: raw.extra_usage?.monthly_limit ?? null,
        utilization: raw.extra_usage?.utilization ?? null,
      },
      raw,
    };
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

/** "2h 14m" style distance to a reset timestamp. */
export function untilLabel(resetsAt: string | null): string {
  if (!resetsAt) return "unknown";
  const ms = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(ms)) return "unknown";
  const mins = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** One-line human summary for the REPL. */
export function usageLine(u: PlanUsage): string {
  const parts: string[] = [];
  if (u.fiveHour.percent !== null) {
    parts.push(`5h session ${u.fiveHour.percent}% (resets in ${untilLabel(u.fiveHour.resetsAt)})`);
  }
  if (u.weekly) parts.push(`weekly ${u.weekly.percent ?? 0}% (resets in ${untilLabel(u.weekly.resetsAt)})`);
  parts.push(`extra usage ${u.extraUsage.enabled ? "on" : "off"}`);
  return parts.join(" · ");
}
