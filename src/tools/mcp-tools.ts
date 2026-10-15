/**
 * Agent tools for MCP — they let the agent manage and use MCP servers by itself.
 *
 *   mcp_servers   list the configured servers (and whether they are reachable)
 *   mcp_add       add / update a server (http, sse or stdio) and test it
 *   mcp_remove    delete a server
 *   mcp_tools     discover the tools of a server (names first, one tool's full schema on request)
 *   mcp_call      call any tool of any configured server
 *
 * Servers added with `mcp_add` can be used right away through `mcp_tools` +
 * `mcp_call`; from the next task on, their tools also appear as individually
 * typed `mcp_<server>_<tool>` tools. Set WRONGFORGE_MCP_AGENT_MANAGE=0 to make
 * the agent read-only (it can still list and call, but not add or remove).
 */

import { tool } from "ai";
import { z } from "zod";
import { currentContext } from "../context.js";
import { defaultMcpRegistry, type McpRegistry } from "../mcp/registry.js";
import { redactSpec } from "../mcp/config.js";

const registry = (): McpRegistry => currentContext()?.mcp ?? defaultMcpRegistry();

const canManage = (): boolean => !/^(0|false|no|off)$/i.test(process.env.WRONGFORGE_MCP_AGENT_MANAGE ?? "1");
const DENIED = "managing MCP servers is disabled on this server (WRONGFORGE_MCP_AGENT_MANAGE=0); ask the operator";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const mcpServers = tool({
  description:
    "Lists the MCP (Model Context Protocol) servers that are configured, with their " +
    "transport, whether they are enabled and currently connected, and the last error. " +
    "Use it first to see what is available; then `mcp_tools` to see a server's tools.",
  inputSchema: z.object({}),
  execute: async () => {
    const s = registry().status();
    return {
      ok: true,
      config_file: s.file,
      servers: s.servers.map((x) => ({
        name: x.name,
        transport: x.spec.type,
        enabled: x.spec.enabled !== false,
        eager: x.spec.eager !== false,
        description: x.spec.description,
        connected: x.connected,
        tools_cached: x.tools_cached,
        last_error: x.last_error,
        spec: x.spec,
      })),
      invalid_entries: s.errors,
    };
  },
});

export const mcpAdd = tool({
  description:
    "Adds or replaces an MCP server in the persistent configuration and tests the connection. " +
    "Remote servers: give `url` (type http = Streamable HTTP, or sse) and optional `headers`. " +
    "Local servers: give `command` and `args` (type stdio), e.g. command \"npx\", args " +
    "[\"-y\",\"@modelcontextprotocol/server-filesystem\",\"/some/dir\"]. " +
    "Put secrets in environment variables and reference them as ${NAME} inside headers/env/url " +
    "instead of writing the secret itself. The server's tools become usable right away via " +
    "`mcp_tools` + `mcp_call`.",
  inputSchema: z.object({
    name: z.string().describe("Short id: letters, digits, _ or - (max 32)"),
    type: z.enum(["http", "sse", "stdio"]).optional().describe("Inferred: url -> http, command -> stdio"),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional().describe('e.g. {"Authorization":"Bearer ${GITHUB_TOKEN}"}'),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    description: z.string().max(500).optional().describe("What the server is for"),
    eager: z.boolean().optional().describe("Expose its tools individually at task start (default true)"),
    enabled: z.boolean().optional(),
    allow: z.array(z.string()).optional().describe("Only these tool names (suffix * allowed)"),
    deny: z.array(z.string()).optional().describe("Never these tool names (suffix * allowed)"),
    timeout_ms: z.number().int().optional().describe("Per call timeout (default 120000)"),
    test: z.boolean().optional().describe("Connect and list tools after saving (default true)"),
  }),
  execute: async ({ name, test, ...spec }) => {
    if (!canManage()) return { ok: false, error: DENIED };
    const reg = registry();
    let saved;
    try {
      saved = reg.addServer(name, spec);
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
    const result: Record<string, unknown> = {
      ok: true,
      saved: name,
      replaced_existing: saved.existed,
      spec: redactSpec(saved.spec),
    };
    if (test !== false) {
      const t = await reg.test(name);
      result.connection = t.ok
        ? { ok: true, server: t.server_info, tool_count: t.tools.length, tools: t.tools.map((x) => x.name).slice(0, 50), instructions: t.instructions }
        : { ok: false, error: t.error };
      if (!t.ok) result.note = "saved, but the connection test failed — fix the settings and call mcp_add again, or mcp_remove it";
    }
    return result;
  },
});

export const mcpRemove = tool({
  description: "Removes an MCP server from the persistent configuration (and closes its connection).",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => {
    if (!canManage()) return { ok: false, error: DENIED };
    const removed = registry().removeServer(name);
    return removed ? { ok: true, removed: name } : { ok: false, error: `no MCP server named "${name}"` };
  },
});

export const mcpTools = tool({
  description:
    "Discovers the tools of one configured MCP server. Without `tool` it returns every tool's " +
    "name and a short description; with `tool` it returns that tool's full description and JSON " +
    "input schema, which you need before calling it with `mcp_call`.",
  inputSchema: z.object({
    server: z.string().describe("Server name from mcp_servers"),
    tool: z.string().optional().describe("Tool name — returns its full input schema"),
    refresh: z.boolean().optional().describe("Ignore the cached tool list"),
  }),
  execute: async ({ server, tool: toolName, refresh }) => {
    try {
      const defs = await registry().listTools(server, { refresh });
      if (toolName) {
        const d = defs.find((x) => x.name === toolName);
        if (!d) return { ok: false, error: `server "${server}" has no tool "${toolName}"`, available: defs.map((x) => x.name) };
        return { ok: true, server, tool: d.name, description: d.description, input_schema: d.schema };
      }
      return {
        ok: true,
        server,
        count: defs.length,
        tools: defs.map((d) => ({ name: d.name, description: d.description.length > 200 ? `${d.description.slice(0, 200)}…` : d.description })),
        hint: "call mcp_tools again with `tool` to get one tool's input schema",
      };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  },
});

export const mcpCall = tool({
  description:
    "Calls a tool of a configured MCP server and returns its result ({ok, output} or {ok:false, error}). " +
    "Find the server with `mcp_servers`, the tool and its input schema with `mcp_tools`. " +
    "If the server's tools are already available as individual `mcp_<server>_<tool>` tools, prefer those.",
  inputSchema: z.object({
    server: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()).optional().describe("Arguments object matching the tool's input schema"),
  }),
  execute: async ({ server, tool: toolName, input }, options) =>
    registry().callTool(server, toolName, input ?? {}, {
      signal: options?.abortSignal,
      taskId: currentContext()?.taskId,
    }),
});
