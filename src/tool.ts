/**
 * Local tool definition — the WrongForge replacement for the Vercel AI SDK's
 * `tool()` / `dynamicTool()` helpers (the agent loop runs on the official
 * Anthropic SDK, see agent.ts).
 *
 * A tool is a name (its key in the ToolSet), a description, an input schema
 * (zod for built-ins, raw JSON Schema for gateway/MCP tools) and an execute
 * function. Zod inputs are validated before execute runs, matching the
 * behavior the AI SDK provided for free.
 */

import { z } from "zod";

export interface ToolExecuteOptions {
  abortSignal?: AbortSignal;
  toolCallId?: string;
}

export interface ToolDef {
  description: string;
  /** zod input schema (built-in tools). Validated before execute. */
  inputSchema?: z.ZodType;
  /**
   * Raw JSON Schema (tools that arrive with a schema from an orchestrator or
   * an MCP server). Used as-is; no local validation beyond the API's own.
   */
  inputJsonSchema?: Record<string, unknown>;
  execute: (input: any, options: ToolExecuteOptions) => Promise<unknown>;
}

export type ToolSet = Record<string, ToolDef>;

/** Defines a tool with a zod schema — the built-in tools' form. */
export function tool<S extends z.ZodType>(def: {
  description: string;
  inputSchema: S;
  execute: (input: z.output<S>, options: ToolExecuteOptions) => Promise<unknown>;
}): ToolDef {
  return {
    description: def.description,
    inputSchema: def.inputSchema,
    execute: def.execute as ToolDef["execute"],
  };
}

/** Defines a tool from a raw JSON Schema (gateway / MCP eager tools). */
export function dynamicTool(def: {
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: any, options: ToolExecuteOptions) => Promise<unknown>;
}): ToolDef {
  return {
    description: def.description,
    inputJsonSchema: def.inputSchema,
    execute: def.execute,
  };
}

/** Runs a tool: validates zod inputs, never throws into the agent loop. */
export async function runTool(
  def: ToolDef | undefined,
  input: unknown,
  options: ToolExecuteOptions,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  if (!def) return { ok: false, error: `unknown tool` };
  try {
    const parsed = def.inputSchema ? def.inputSchema.parse(input) : input;
    const output = await def.execute(parsed, options);
    return { ok: true, output };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
