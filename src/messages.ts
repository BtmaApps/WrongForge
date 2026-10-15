/**
 * WrongForge's conversation history format and its conversion to/from the
 * Anthropic Messages API wire format.
 *
 * The stored shape is deliberately the same JSON the Vercel AI SDK's
 * ModelMessage used (roles user/assistant/tool with `text`, `tool-call` and
 * `tool-result` parts), so existing session files and compaction keep
 * working unchanged. Conversion to the API's shape (tool_use blocks in
 * assistant messages, tool_result blocks in user messages) happens here,
 * right before each request.
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
}

export type AgentMessage =
  | { role: "user"; content: string | TextPart[] }
  | { role: "assistant"; content: string | (TextPart | ToolCallPart)[] }
  | { role: "tool"; content: ToolResultPart[] };

// ------------------------------------------------------ to the API wire format

export interface ApiTextBlock {
  type: "text";
  text: string;
}
export interface ApiToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ApiToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
export type ApiContentBlock = ApiTextBlock | ApiToolUseBlock | ApiToolResultBlock;
export interface ApiMessage {
  role: "user" | "assistant";
  content: ApiContentBlock[];
}

function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return String(output);
  }
}

/**
 * Converts the stored history into API messages. `tool` messages become user
 * messages carrying tool_result blocks — the API has no tool role.
 */
export function toApiMessages(history: AgentMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      const blocks: ApiContentBlock[] =
        typeof msg.content === "string"
          ? msg.content
            ? [{ type: "text", text: msg.content }]
            : []
          : msg.content.map((p) => ({ type: "text" as const, text: p.text }));
      if (blocks.length) out.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      const blocks: ApiContentBlock[] =
        typeof msg.content === "string"
          ? msg.content
            ? [{ type: "text", text: msg.content }]
            : []
          : msg.content.map((p) =>
              p.type === "text"
                ? { type: "text" as const, text: p.text }
                : { type: "tool_use" as const, id: p.toolCallId, name: p.toolName, input: p.input ?? {} },
            );
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else {
      const blocks: ApiToolResultBlock[] = msg.content.map((p) => ({
        type: "tool_result",
        tool_use_id: p.toolCallId,
        content: outputToText(p.output),
      }));
      if (blocks.length) out.push({ role: "user", content: blocks });
    }
  }
  return out;
}

/** Renders a finished API message back into the stored shape (history push). */
export function fromApiAssistantMessage(content: Array<{ type: string } & Record<string, unknown>>): AgentMessage {
  const parts: (TextPart | ToolCallPart)[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ type: "text", text: String(b.text ?? "") });
    else if (b.type === "tool_use") parts.push({ type: "tool-call", toolCallId: String(b.id), toolName: String(b.name), input: b.input ?? {} });
  }
  return { role: "assistant", content: parts };
}
