/**
 * Prompt-cache breakpoints for /v1/messages requests.
 *
 * Anthropic caches the request PREFIX in the order  tools -> system -> messages,
 * up to every block marked with `cache_control`. We mark two blocks:
 *
 *   1. the last system block      -> tools + system stay cached even when the
 *                                    conversation tail changes
 *   2. the last block of the last -> the whole conversation so far; the marker
 *      message                       moves forward with every request, so each
 *                                    request reads what the previous one wrote
 *
 * That is 2 of the 4 allowed breakpoints. Both use the same TTL.
 *
 * A cache hit needs a byte-identical prefix: same model, same tools, same
 * system text, same earlier messages. Change any of them and everything after
 * the change is re-processed (and re-written to the cache).
 *
 * Mode (per task via the `cache` field, default from WRONGFORGE_CACHE):
 *   "5m"  default Anthropic lifetime (writes cost 1.25x, refreshed free on every hit)
 *   "1h"  1-hour lifetime (writes cost 2x) — for sessions resumed minutes apart
 *   "off" no cache_control at all
 */

export type CacheMode = "5m" | "1h" | "off";

export const CACHE_MODES: readonly CacheMode[] = ["5m", "1h", "off"];

export function isCacheMode(v: unknown): v is CacheMode {
  return typeof v === "string" && (CACHE_MODES as readonly string[]).includes(v);
}

/** Server-wide default: WRONGFORGE_CACHE, falling back to "1h". */
export function defaultCacheMode(env: NodeJS.ProcessEnv = process.env): CacheMode {
  const v = env.WRONGFORGE_CACHE?.trim().toLowerCase();
  return isCacheMode(v) ? v : "1h";
}

interface Block {
  type?: string;
  text?: string;
  cache_control?: unknown;
  [k: string]: unknown;
}

const CACHEABLE = new Set(["text", "tool_use", "tool_result", "image", "document"]);

function marker(mode: Exclude<CacheMode, "off">): { type: "ephemeral"; ttl?: "1h" } {
  return mode === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function ttlOf(cc: unknown): "1h" | "5m" | undefined {
  if (!cc || typeof cc !== "object") return undefined;
  return (cc as { ttl?: unknown }).ttl === "1h" ? "1h" : "5m";
}

/**
 * Scans for the FIRST `cache_control` already present anywhere in the body
 * (a system block, or any message's content blocks) and returns its ttl.
 *
 * WrongForge's own agent/task requests are always built cache_control-free
 * from scratch on every call (see src/agent.ts's toApiMessages — the stored
 * message format has no such field), so for them this is always undefined
 * and the function below behaves exactly as before. It matters on the raw
 * proxy surface (src/proxy.ts): a client with its own growing conversation
 * can already carry a `cache_control` (its own prior turn, or its own
 * caching strategy) with a DIFFERENT ttl than this server's current
 * default. Blindly adding a fresh breakpoint with today's default would
 * then mix ttls in one request — exactly what Anthropic rejects outright
 * ("a ttl='1h' cache_control block must not come after a ttl='5m' ...").
 * Pinning to whatever the conversation already established avoids that,
 * without changing whether a breakpoint gets added at all.
 */
function establishedTtl(body: any): "1h" | "5m" | undefined {
  if (Array.isArray(body?.system)) {
    for (const b of body.system) {
      const ttl = ttlOf((b as Block | undefined)?.cache_control);
      if (ttl) return ttl;
    }
  }
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      const content = msg?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        const ttl = ttlOf((b as Block | undefined)?.cache_control);
        if (ttl) return ttl;
      }
    }
  }
  return undefined;
}

/**
 * Adds the two breakpoints to a parsed /v1/messages body (mutates it).
 * Blocks that already carry a `cache_control` are left alone.
 * Returns the number of breakpoints that are present afterwards.
 */
export function applyCacheBreakpoints(body: any, mode: CacheMode): number {
  if (mode === "off" || !body || typeof body !== "object") return 0;
  const cc = marker(establishedTtl(body) ?? mode);
  let count = 0;

  // 1. last system block
  if (Array.isArray(body.system) && body.system.length) {
    const last = body.system[body.system.length - 1] as Block;
    if (last && last.type === "text" && last.text) {
      last.cache_control ??= cc;
      count++;
    }
  }

  // 2. last block of the last message
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length) {
    const msg = msgs[msgs.length - 1];
    if (typeof msg?.content === "string") {
      if (msg.content) {
        msg.content = [{ type: "text", text: msg.content, cache_control: cc }];
        count++;
      }
    } else if (Array.isArray(msg?.content) && msg.content.length) {
      const last = msg.content[msg.content.length - 1] as Block;
      if (last && CACHEABLE.has(String(last.type)) && !(last.type === "text" && !last.text)) {
        last.cache_control ??= cc;
        count++;
      }
    }
  }
  return count;
}
