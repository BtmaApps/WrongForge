/**
 * Reasoning effort for /v1/messages requests (the `effort` field).
 *
 * Effort-capable Claude models accept `effort: "low" | "medium" | "high"`,
 * trading answer depth for output tokens. Which levels a model understands
 * depends on its family: `effortSupport()` maps model ids to the levels they
 * accept and `resolveEffort()` clamps a requested setting to the nearest
 * supported one, so one setting works across the whole lineup (asking "high"
 * on a model that tops out at "medium" sends "medium", not an API error).
 *
 * Setting (per task via the `effort` submit field, REPL via /effort, default
 * from WRONGFORGE_EFFORT):
 *   "low" | "medium" | "high"   send that effort, clamped to model support
 *   "off"                       never send the field (pre-effort behavior)
 *
 * Unknown/future model ids (e.g. live /v1/models entries newer than the
 * table below) are assumed effort-capable; if the API then rejects the
 * parameter, provider.ts drops it, retries once and stops sending it for
 * THAT model — the same self-healing cache_control already uses.
 */

import { currentContext } from "./context.js";

export type Effort = "low" | "medium" | "high";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

/** A configured effort: a level, or "off" to omit the field entirely. */
export type EffortSetting = Effort | "off";

export const EFFORT_SETTINGS: readonly EffortSetting[] = ["low", "medium", "high", "off"];

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

export function isEffortSetting(v: unknown): v is EffortSetting {
  return typeof v === "string" && (EFFORT_SETTINGS as readonly string[]).includes(v);
}

/** Server-wide default: WRONGFORGE_EFFORT, falling back to "high". */
export function defaultEffort(env: NodeJS.ProcessEnv = process.env): EffortSetting {
  const v = env.WRONGFORGE_EFFORT?.trim().toLowerCase();
  return isEffortSetting(v) ? v : "high";
}

// ------------------------------------------------------------- model support

const ALL = EFFORTS;
const NONE: readonly Effort[] = [];

/**
 * Model families → accepted effort levels. Rules run most-specific first:
 * the 4-5 rule must be tested before the bare "4" rule because
 * "claude-sonnet-4-5" also matches /^claude-sonnet-4/. Ids that match no rule
 * (anything newer than this table) fall through to ALL.
 */
const EFFORT_RULES: Array<[RegExp, readonly Effort[]]> = [
  // 5.x family — the current lineup
  [/^claude-(haiku|sonnet|opus|fable)-5(-|$)/, ALL],
  // 4.5 family — the first generation with the effort parameter
  [/^claude-(haiku|sonnet|opus)-4-5(-|$)/, ALL],
  // 3.x and the 4.0/4.1 generation — extended-thinking budget era, no effort field
  [/^claude-(3|haiku-4|sonnet-4|opus-4)/, NONE],
];

/** Which effort levels a model id accepts (empty = the model has none). */
export function effortSupport(model: string): readonly Effort[] {
  for (const [re, levels] of EFFORT_RULES) {
    if (re.test(model)) return levels;
  }
  return ALL;
}

// ---------------------------------------------------------------- resolution

const RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/** Nearest supported level to `setting` (ties prefer the lower one). */
export function clampEffort(setting: Effort, supported: readonly Effort[]): Effort {
  const want = RANK[setting];
  let best = supported[0];
  for (const lvl of supported) {
    if (Math.abs(RANK[lvl] - want) < Math.abs(RANK[best] - want)) best = lvl;
  }
  return best;
}

export interface ResolvedEffort {
  /** Value for the request's `effort` field; null = omit the field. */
  effort: Effort | null;
  /** True when the setting was adjusted to what the model supports. */
  clamped: boolean;
  /** True when the model has no effort support at all. */
  unsupported: boolean;
}

/**
 * Maps a setting onto a model: "off" and effort-incapable models omit the
 * field; a level the model lacks is clamped to the nearest one it has.
 */
export function resolveEffort(setting: EffortSetting, model: string): ResolvedEffort {
  if (setting === "off") return { effort: null, clamped: false, unsupported: false };
  const supported = effortSupport(model);
  if (supported.length === 0) return { effort: null, clamped: false, unsupported: true };
  if ((supported as readonly string[]).includes(setting)) {
    return { effort: setting, clamped: false, unsupported: false };
  }
  return { effort: clampEffort(setting, supported), clamped: true, unsupported: false };
}

/**
 * Sets `effort` on a parsed /v1/messages body according to the setting and
 * the body's own `model` — a no-op when the field must not be sent. The
 * provider-layer counterpart of applyCacheBreakpoints in cache.ts.
 * Returns the value that was set, or null when the field stays absent.
 */
export function applyEffortToBody(body: any, setting: EffortSetting): Effort | null {
  const resolved = resolveEffort(setting, String(body?.model ?? ""));
  if (resolved.effort) body.effort = resolved.effort;
  return resolved.effort;
}

// ------------------------------------------------- process-wide session state

let sessionOverride: EffortSetting | null = null;

/**
 * REPL override (/effort): wins over WRONGFORGE_EFFORT for this process.
 * `null` clears it back to the env default.
 */
export function setSessionEffort(e: EffortSetting | null): void {
  sessionOverride = e;
}

export function sessionEffort(): EffortSetting | null {
  return sessionOverride;
}

let effortRejectedAll = false;
const rejectedModels = new Set<string>();

/**
 * Set by provider.ts when the API refused the `effort` field. With a model id
 * only THAT model loses effort (others keep theirs — a capable model must not
 * be punished for an incapable one); without one (unparseable body) the whole
 * process opts out. Learned per process, never persisted.
 */
export function markEffortRejected(model?: string): void {
  if (model) rejectedModels.add(model);
  else effortRejectedAll = true;
}

export function effortRejectedOnce(model?: string): boolean {
  return effortRejectedAll || (model !== undefined && rejectedModels.has(model));
}

/** Test isolation: forget the learned rejections. */
export function resetEffortRejections(): void {
  effortRejectedAll = false;
  rejectedModels.clear();
}

/**
 * The effort setting that applies to a request being built right now:
 * task override (context) > REPL /effort override > env default;
 * "off" for models the API has already refused the parameter for.
 */
export function effectiveEffort(model: string, env: NodeJS.ProcessEnv = process.env): EffortSetting {
  if (effortRejectedOnce(model)) return "off";
  return currentContext()?.effort ?? sessionEffort() ?? defaultEffort(env);
}
