/**
 * Human-readable one-line summaries of Anthropic Messages API bodies, used
 * by the Proxy tab's JsonPeek buttons instead of a flat "raw" label — the
 * full JSON is still one click away (JsonPeek's own dialog never changes,
 * see bits.tsx).
 *
 * Two distinct shapes feed through here, both coming straight off the wire:
 *   - request_body: always parsed JSON (unless it exceeded the tap's byte cap).
 *   - response_body: parsed JSON for a non-streaming call; for a streaming
 *     call it is the RAW concatenated SSE wire text — the server never
 *     reconstructs it (see src/proxy.ts's streaming tee) — so summarizing a
 *     streaming response first needs a light, best-effort SSE-event replay.
 *
 * Every entry point is defensive: an unexpected shape (a truncated body, a
 * future API field, a non-Anthropic body) must never throw — summarizing is
 * a convenience, not a correctness requirement, so any failure falls back
 * to the plain "raw" label rather than breaking the tab.
 */

interface ContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

function blockToLine(b: ContentBlockLike): string {
  switch (b.type) {
    case "text":
      return clip(String(b.text ?? "").replace(/\s+/g, " ").trim(), 100);
    case "thinking":
      return "(thinking)";
    case "tool_use":
      return `⇢ ${b.name ?? "tool"}(${clip(safeJson(b.input ?? {}), 60)})`;
    case "tool_result": {
      const inner = typeof b.content === "string" ? b.content : safeJson(b.content);
      return `⇠ ${clip(inner.replace(/\s+/g, " ").trim(), 80)}`;
    }
    case "image":
      return "(image)";
    case "document":
      return "(document)";
    default:
      return `(${b.type ?? "block"})`;
  }
}

/** Summarizes a content block array (the shape both a message and a
 *  response's top-level `content` use) into one joined line. */
export function summarizeContentBlocks(blocks: unknown): string {
  if (typeof blocks === "string") return clip(blocks.replace(/\s+/g, " ").trim(), 100);
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  return blocks.map((b) => blockToLine(b as ContentBlockLike)).join(" · ");
}

/** The last message's own summary — what a request's cached prefix actually ends with. */
function lastMessageSummary(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const last = messages[messages.length - 1] as { role?: string; content?: unknown };
  const body = summarizeContentBlocks(last?.content);
  return body ? `${last?.role ?? "?"}: ${body}` : "";
}

export function summarizeAnthropicRequest(body: unknown): string {
  try {
    if (!body || typeof body !== "object") return "raw";
    const b = body as { model?: string; messages?: unknown[]; tools?: unknown[] };
    const parts: string[] = [];
    if (b.model) parts.push(`model=${b.model}`);
    if (Array.isArray(b.messages)) parts.push(`${b.messages.length} msg${b.messages.length === 1 ? "" : "s"}`);
    if (Array.isArray(b.tools) && b.tools.length) parts.push(`${b.tools.length} tools`);
    const last = lastMessageSummary(b.messages);
    if (last) parts.push(last);
    return parts.join(" · ") || "raw";
  } catch {
    return "raw";
  }
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ReconstructedMessage {
  content: unknown[];
  stop_reason?: string;
  usage?: UsageLike;
}

/**
 * Rebuilds an approximate final Message shape from the raw concatenated SSE
 * wire text a streaming call's response_body carries (never parsed by the
 * server — see the file header). Best-effort: the tap's byte cap can cut
 * the capture mid-event, so this simply yields whatever could be assembled
 * before the cut; it never throws, and returns null only when nothing in
 * `raw` parsed as an SSE data line at all.
 */
function reconstructFromSse(raw: string): ReconstructedMessage | null {
  const blocks: ContentBlockLike[] = [];
  const partialInputs = new Map<number, string>();
  let stop_reason: string | undefined;
  let usage: ReconstructedMessage["usage"];
  let sawAny = false;

  for (const chunk of raw.split("\n\n")) {
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(dataLine.slice(5).trim());
    } catch {
      continue; // a cut-off final chunk from truncation — ignore, keep what was assembled
    }
    sawAny = true;
    const type = ev.type as string | undefined;
    if (type === "message_start") {
      const m = ev.message as { usage?: typeof usage } | undefined;
      if (m?.usage) usage = { ...usage, ...m.usage };
    } else if (type === "content_block_start") {
      const idx = ev.index as number;
      blocks[idx] = { ...(ev.content_block as ContentBlockLike) };
    } else if (type === "content_block_delta") {
      const idx = ev.index as number;
      const b = blocks[idx];
      if (!b) continue;
      const delta = ev.delta as { type?: string; text?: string; partial_json?: string; thinking?: string };
      if (delta.type === "text_delta") b.text = `${b.text ?? ""}${delta.text ?? ""}`;
      else if (delta.type === "thinking_delta") b.thinking = `${b.thinking ?? ""}${delta.thinking ?? ""}`;
      else if (delta.type === "input_json_delta") partialInputs.set(idx, `${partialInputs.get(idx) ?? ""}${delta.partial_json ?? ""}`);
    } else if (type === "message_delta") {
      const d = ev.delta as { stop_reason?: string } | undefined;
      if (d?.stop_reason) stop_reason = d.stop_reason;
      const u = ev.usage as typeof usage | undefined;
      if (u) usage = { ...usage, ...u };
    }
  }
  if (!sawAny) return null;

  for (const [idx, json] of partialInputs) {
    const b = blocks[idx];
    if (!b || b.type !== "tool_use") continue;
    try {
      b.input = JSON.parse(json);
    } catch {
      /* incomplete JSON from a truncated capture — leave whatever input was already there */
    }
  }
  return { content: blocks.filter(Boolean), stop_reason, usage };
}

/** Formats `in=X out=Y`, appending cache write/read token counts (the
 *  clearest signal of whether prompt caching is actually hitting) whenever
 *  the API reported either as nonzero. */
function usageLine(u: UsageLike): string {
  const base = `in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"}`;
  const w = u.cache_creation_input_tokens ?? 0;
  const r = u.cache_read_input_tokens ?? 0;
  if (w === 0 && r === 0) return base;
  return `${base} · cache +${w}w/${r}r`;
}

/** An Anthropic error envelope: `{type:"error", error:{type, message}}` (also
 *  tolerates a bare `{error:{...}}` without the outer `type`, seen on some
 *  non-2xx bodies). Checked before the message-shape parse below since an
 *  error body has none of `content`/`stop_reason`/`usage`. */
function errorSummary(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: { type?: string; message?: string } }).error;
  if (!err || typeof err !== "object") return null;
  const type = err.type ?? "error";
  const message = typeof err.message === "string" ? clip(err.message.replace(/\s+/g, " ").trim(), 140) : "";
  return message ? `error: ${type} — ${message}` : `error: ${type}`;
}

export function summarizeAnthropicResponse(body: unknown, opts: { stream?: boolean } = {}): string {
  try {
    let msg: ReconstructedMessage;
    if (typeof body === "string") {
      if (!opts.stream) {
        try {
          const err = errorSummary(JSON.parse(body));
          if (err) return err;
        } catch {
          /* not JSON — fall through to the plain-text clip below */
        }
        return clip(body.replace(/\s+/g, " ").trim(), 100) || "raw";
      }
      const reconstructed = reconstructFromSse(body);
      if (!reconstructed) return "raw";
      msg = reconstructed;
    } else if (body && typeof body === "object") {
      const err = errorSummary(body);
      if (err) return err;
      const b = body as { content?: unknown[]; stop_reason?: string; usage?: ReconstructedMessage["usage"] };
      msg = { content: Array.isArray(b.content) ? b.content : [], stop_reason: b.stop_reason, usage: b.usage };
    } else {
      return "raw";
    }
    const parts: string[] = [];
    if (msg.stop_reason) parts.push(`finish=${msg.stop_reason}`);
    if (msg.usage) parts.push(usageLine(msg.usage));
    const content = summarizeContentBlocks(msg.content);
    if (content) parts.push(content);
    return parts.join(" · ") || "raw";
  } catch {
    return "raw";
  }
}
