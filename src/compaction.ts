/**
 * Context management for long sessions.
 *
 * A session's whole history is sent with every request. Two defenses keep it
 * from outgrowing the model's context window:
 *
 *  1. In-task guard — `clearOldToolOutputs` (used from `prepareStep` in
 *     agent.ts): when the live context passes `clearAt` tokens, old tool
 *     outputs are replaced by a short placeholder (the model's own text and
 *     tool calls stay). Cheap, no extra model call.
 *
 *  2. Between tasks — `compactMessages`: older turns are summarized by the
 *     model into one message; the most recent turns stay verbatim. The
 *     originals are archived by the session store, never lost.
 *
 * Both change the request prefix once, so the prompt cache is rewritten once
 * and then stable again. Sizes come from the API's own usage numbers, not
 * from guesses.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentMessage } from "./messages.js";
import { runInContext } from "./context.js";

export const CLEARED_PLACEHOLDER = "[tool output cleared to save context]";

// ------------------------------------------------------------------- config

export interface ContextConfig {
  /** Model context window in tokens (default 1 000 000). Used for percentages. */
  window: number;
  /** Compact a session before a task when its context exceeds this (0 = never). Default 150 000. */
  compactAt: number;
  /** Clear old tool outputs inside a task when the live context exceeds this (0 = never). Default 600 000. */
  clearAt: number;
  /** Turns (tasks) kept verbatim by a compaction. Default 2. */
  keepTurns: number;
  /** Most recent tool results never cleared by the in-task guard. Default 8. */
  keepToolResults: number;
  /** Model for the summary (default: the task's model). */
  summaryModel?: string;
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

export function contextConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ContextConfig {
  return {
    window: num(env.WRONGFORGE_CONTEXT_WINDOW, 1_000_000) || 1_000_000,
    compactAt: num(env.WRONGFORGE_COMPACT_AT, 150_000),
    clearAt: num(env.WRONGFORGE_CLEAR_AT, 600_000),
    keepTurns: Math.max(1, num(env.WRONGFORGE_COMPACT_KEEP_TURNS, 2)),
    keepToolResults: Math.max(1, num(env.WRONGFORGE_KEEP_TOOL_RESULTS, 8)),
    summaryModel: env.WRONGFORGE_SUMMARY_MODEL || undefined,
  };
}

/** Does this provider error mean "the prompt does not fit"? */
export function isContextOverflow(text: string): boolean {
  return /prompt is too long|input is too long|context (length|window)|exceeds? the (maximum|context)|too many (input )?tokens|maximum context/i.test(
    text,
  );
}

// ------------------------------------------------------- 1. clear tool outputs

/**
 * Replaces the output of all but the last `keepRecent` tool results with a
 * placeholder. Returns new message objects where something changed; the input
 * array and its messages are not mutated.
 */
export function clearOldToolOutputs(
  messages: AgentMessage[],
  keepRecent: number,
): { messages: AgentMessage[]; cleared: number } {
  const slots: { m: number; p: number }[] = [];
  messages.forEach((msg, m) => {
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      msg.content.forEach((part: any, p: number) => {
        if (part?.type === "tool-result") slots.push({ m, p });
      });
    }
  });
  const toClear = slots.slice(0, Math.max(0, slots.length - keepRecent));
  const isCleared = (part: any): boolean => part?.output?.type === "text" && part.output.value === CLEARED_PLACEHOLDER;

  const out = [...messages];
  let cleared = 0;
  for (const { m, p } of toClear) {
    const msg = out[m] as any;
    if (isCleared(msg.content[p])) continue;
    if (out[m] === messages[m]) out[m] = { ...msg, content: [...msg.content] } as AgentMessage;
    (out[m] as any).content[p] = { ...msg.content[p], output: { type: "text", value: CLEARED_PLACEHOLDER } };
    cleared++;
  }
  return { messages: cleared ? out : messages, cleared };
}

// -------------------------------------------------------------- 2. compaction

/** Splits a history into turns; every `user` message starts a new one. */
export function splitTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = [];
  for (const m of messages) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);

function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Plain-text rendering of messages for the summarizer (tool I/O trimmed). */
export function renderTranscript(messages: AgentMessage[], maxChars = 600_000): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`USER: ${clip(partsToText(msg.content), 8000)}`);
    } else if (msg.role === "assistant") {
      const text = partsToText(msg.content);
      if (text) lines.push(`ASSISTANT: ${clip(text, 8000)}`);
      if (Array.isArray(msg.content)) {
        for (const p of msg.content as any[]) {
          if (p?.type === "tool-call") lines.push(`  [tool call] ${p.toolName} ${clip(JSON.stringify(p.input ?? {}), 400)}`);
        }
      }
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const p of msg.content as any[]) {
        if (p?.type !== "tool-result") continue;
        const v = p.output?.value ?? p.output;
        const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
        lines.push(`  [tool result] ${p.toolName}: ${clip(s, 500)}`);
      }
    }
  }
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const head = Math.floor(maxChars * 0.2);
  const tail = maxChars - head;
  return `${full.slice(0, head)}\n…[${full.length - maxChars} chars omitted from the middle]…\n${full.slice(full.length - tail)}`;
}

const SUMMARY_SYSTEM = `You compress the history of a coding agent's work session so the agent can continue it later with no other memory of it.
Write a dense, factual summary in Markdown with these sections:
## Goals
## What was done   (chronological and concrete: files created/changed with their paths, commands run and what they returned)
## Current state
## Decisions and constraints
## Open problems / next steps
## Key facts       (exact paths, ids, names, commands, URLs and error messages worth remembering)
Preserve exact identifiers, paths and error text. Do not invent anything. No preamble, no closing remarks.`;

export const SUMMARY_PREFIX = "[Summary of the earlier part of this session — the full details were archived]";
const SUMMARY_ACK = "Understood. I have the summary of the earlier work and will continue from it.";

export interface CompactResult {
  /** The new, shorter history. */
  messages: AgentMessage[];
  /** The summary text. */
  summary: string;
  messages_before: number;
  messages_after: number;
  turns_summarized: number;
  turns_kept: number;
}

/**
 * Summarizes everything except the last `keepTurns` turns. Returns null when
 * there is nothing to summarize (fewer turns than `keepTurns + 1`).
 * The summary call is made without prompt caching (it is a one-off prefix).
 */
export async function compactMessages(
  client: Anthropic,
  modelId: string,
  messages: AgentMessage[],
  keepTurns: number,
  abortSignal?: AbortSignal,
): Promise<CompactResult | null> {
  const turns = splitTurns(messages);
  if (turns.length <= keepTurns) return null;
  const older = turns.slice(0, turns.length - keepTurns).flat();
  const recent = turns.slice(turns.length - keepTurns).flat();

  const res = await runInContext({ cwd: process.cwd(), env: {}, todos: [], cache: "off" }, () =>
    client.messages.create(
      {
        model: modelId,
        max_tokens: 4000,
        system: [{ type: "text", text: SUMMARY_SYSTEM }],
        messages: [{ role: "user", content: renderTranscript(older) }],
      },
      { signal: abortSignal },
    ),
  );
  const summary = res.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!summary) throw new Error("the model returned an empty summary");

  const next: AgentMessage[] = [
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` },
    { role: "assistant", content: SUMMARY_ACK },
    ...recent,
  ];
  return {
    messages: next,
    summary,
    messages_before: messages.length,
    messages_after: next.length,
    turns_summarized: turns.length - keepTurns,
    turns_kept: keepTurns,
  };
}
