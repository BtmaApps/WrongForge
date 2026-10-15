/**
 * Agent loop: system prompt + tools + multi-step (agentic) execution.
 * streamText + stopWhen lets the model call tools, observe results, and
 * continue — the core Claude Code working pattern.
 */

import { streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { AnthropicProvider } from "@ai-sdk/anthropic";
import { agentTools } from "./tools/index.js";
import { clearOldToolOutputs } from "./compaction.js";

/**
 * Current model lineup — platform.claude.com/docs/en/models/overview (Oct 2026).
 * Dateless IDs are pinned snapshots; the /models command queries
 * GET /v1/models for the live list.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const KNOWN_MODELS: Record<string, string> = {
  "claude-sonnet-5-5": "balanced default — coding and agent work ($2/$10 per MTok)",
  "claude-opus-5-5": "Anthropic's recommendation for most workloads ($4/$20 per MTok)",
  "claude-fable-5-1": "deepest reasoning / long agent runs ($10/$50 per MTok)",
  "claude-haiku-5-5": "fast and economical, high volume ($0.10/$0.50 per MTok)",
};

export const SYSTEM_PROMPT = `You are a terminal-based AI coding assistant running on the user's machine.

Working directory: the shell's current working directory.

Tools:
- bash: run shell commands (builds, tests, git, search); non-interactive flags preferred
- read: read a file with numbered lines (offset/limit for large files)
- write: write new files or full rewrites
- edit: exact string replacement in an existing file
- ls / glob / grep: explore directories, find files by pattern, search contents
- web_fetch: read a public URL as text
- todo_read / todo_write: track a multi-step plan
- report_progress: send a short status update to the orchestrator that started you
- mcp_servers / mcp_tools / mcp_call: use tools of MCP servers (list servers, discover a server's tools and schemas, call a tool); tools named mcp_<server>_<tool> are the same tools, already typed
- mcp_add / mcp_remove: add or remove an MCP server (http, sse or stdio) when a task needs a capability you do not have; reference secrets as \${ENV_VAR}, never write them out

Operating principles:
1. Verify with tools instead of guessing — locate code with glob/grep, then read before editing.
2. For edits, old_string must match exactly and be unique; include surrounding lines for context.
3. Work step by step: read first, then edit; prefer minimal, surgical changes.
4. For multi-step tasks, record the plan with todo_write and keep statuses current.
5. After making changes, validate them (compile, run tests) when practical.
6. Destructive or hard-to-reverse actions (deleting files, force-push, installs) require asking the user first.
7. Answer in the user's language. Be concise; show command output only when it matters.`;

export interface TokenUsage {
  /** All input tokens (cache reads and writes included). */
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Input tokens served from the prompt cache (cheap). */
  cache_read_tokens: number;
  /** Input tokens written to the prompt cache. */
  cache_write_tokens: number;
}

export interface TurnResult {
  finishReason: string;
  toolCalls: number;
  /** Assistant text of this turn (all steps concatenated). */
  text: string;
  /** Number of model steps (LLM round-trips) in this turn. */
  steps: number;
  /** Token usage summed over all steps. */
  usage: TokenUsage;
  /**
   * Size of the conversation after this turn, in tokens: the last request's
   * input (cache included) plus its output. This is what the NEXT request will
   * start from — the number to watch against the context window.
   */
  context_tokens: number;
}

/** In-task context guard (see compaction.ts). */
export interface ContextGuard {
  /** Clear old tool outputs once the live context exceeds this many tokens. */
  clearAt: number;
  /** Most recent tool results that are never cleared. */
  keepToolResults: number;
}

/** Structured events emitted while a turn runs (used by the HTTP server). */
export type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "step_finish"; step: number; finish_reason: string; usage: TokenUsage; context_tokens: number }
  | { type: "context_cleared"; cleared: number; context_tokens: number }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: unknown }
  | { type: "tool_error"; id: string; name: string; error: string }
  | { type: "error"; error: string };

/**
 * Runs one agent turn. Without `onEvent` it prints to the terminal (REPL);
 * with `onEvent` every text delta / tool call / tool result is delivered as a
 * structured event instead and nothing is printed.
 */
export async function runAgentTurn(
  provider: AnthropicProvider,
  modelId: string,
  history: ModelMessage[],
  maxSteps = 20,
  abortSignal?: AbortSignal,
  onEvent?: (e: AgentEvent) => void,
  system: string = SYSTEM_PROMPT,
  guard?: ContextGuard,
  extraTools: ToolSet = {},
): Promise<TurnResult> {
  const result = streamText({
    model: provider(modelId),
    system,
    messages: history,
    // built-in tools first (fixed order), then the orchestrator's (sorted by the
    // gateway) — a stable tool list keeps the prompt cache valid
    tools: { ...agentTools, ...extraTools },
    stopWhen: stepCountIs(maxSteps),
    abortSignal,
    // Keeps one long task from outgrowing the context window: the override
    // carries forward to later steps, so the prefix changes once and is then
    // stable (and cacheable) again.
    prepareStep:
      guard && guard.clearAt > 0
        ? ({ steps, messages }) => {
            const used = steps[steps.length - 1]?.usage.inputTokens ?? 0;
            if (used < guard.clearAt) return {};
            const r = clearOldToolOutputs(messages, guard.keepToolResults);
            if (!r.cleared) return {};
            onEvent?.({ type: "context_cleared", cleared: r.cleared, context_tokens: used });
            return { messages: r.messages };
          }
        : undefined,
  });

  let toolCalls = 0;
  let text = "";
  let steps = 0;
  let contextTokens = 0;
  const usage: TokenUsage = {
    input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  };
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step":
        steps++;
        if (onEvent) onEvent({ type: "step_start", step: steps });
        break;
      case "finish-step": {
        const u: TokenUsage = {
          input_tokens: part.usage.inputTokens ?? 0,
          output_tokens: part.usage.outputTokens ?? 0,
          total_tokens:
            part.usage.totalTokens ??
            (part.usage.inputTokens ?? 0) + (part.usage.outputTokens ?? 0),
          cache_read_tokens: part.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cache_write_tokens: part.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        };
        usage.input_tokens += u.input_tokens;
        usage.output_tokens += u.output_tokens;
        usage.total_tokens += u.total_tokens;
        usage.cache_read_tokens += u.cache_read_tokens;
        usage.cache_write_tokens += u.cache_write_tokens;
        contextTokens = u.input_tokens + u.output_tokens;
        if (onEvent) {
          onEvent({ type: "step_finish", step: steps, finish_reason: String(part.finishReason), usage: u, context_tokens: contextTokens });
        }
        break;
      }
      case "text-delta":
        text += part.text;
        if (onEvent) onEvent({ type: "text", delta: part.text });
        else process.stdout.write(part.text);
        break;
      case "tool-call":
        toolCalls++;
        if (onEvent) {
          onEvent({ type: "tool_call", id: part.toolCallId, name: part.toolName, input: part.input });
        } else {
          console.log(
            `\n\x1b[36m▸ ${part.toolName}\x1b[0m ${summarize(part.input)}`,
          );
        }
        break;
      case "tool-result":
        if (onEvent) {
          onEvent({ type: "tool_result", id: part.toolCallId, name: part.toolName, output: part.output });
        } else {
          console.log(`\x1b[2m  ↳ ${summarize(part.output)}\x1b[0m`);
        }
        break;
      case "tool-error":
        if (onEvent) {
          onEvent({ type: "tool_error", id: part.toolCallId, name: part.toolName, error: String(part.error) });
        } else {
          console.error(`\x1b[31m  ↳ tool error: ${String(part.error)}\x1b[0m`);
        }
        break;
      case "error":
        if (abortSignal?.aborted) break; // reported as an interruption below
        if (onEvent) onEvent({ type: "error", error: String(part.error) });
        else console.error(`\x1b[31m[error] ${String(part.error)}\x1b[0m`);
        break;
      default:
        break;
    }
  }

  // An interrupted turn may end mid tool-call; its partial messages would
  // leave a dangling tool_use in the history, so the caller rolls the turn back.
  if (abortSignal?.aborted) return { finishReason: "aborted", toolCalls, text, steps, usage, context_tokens: contextTokens };

  // Append assistant + tool messages to the history (multi-step context).
  // ai@7: response.messages was removed → result.responseMessages
  const responseMessages = await result.responseMessages;
  history.push(...responseMessages);

  return {
    finishReason: (await result.finishReason) ?? "unknown",
    toolCalls,
    text,
    steps,
    usage,
    context_tokens: contextTokens,
  };
}

function summarize(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined || text === "undefined") text = "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? oneLine.slice(0, 140) + "…" : oneLine;
}
