/**
 * Minimal MCP server for tests. Speaks real JSON-RPC 2.0 MCP.
 *
 *   node mini-mcp.mjs stdio                 newline-delimited JSON on stdin/stdout
 *   node mini-mcp.mjs http <port> [token]   Streamable HTTP on POST /mcp
 *                                           (token given: requires "Authorization: Bearer <token>")
 *
 * Tools: echo, add, fail, slow, whoami_env, secret_tool
 */

import http from "node:http";

const TOOLS = [
  { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "fail", description: "Always reports a tool error", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Sleeps for ms milliseconds", inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } },
  { name: "whoami_env", description: "Returns the value of the MINI_VAR environment variable", inputSchema: { type: "object", properties: {} } },
  { name: "secret_tool", description: "A tool that allow/deny lists should be able to hide", inputSchema: { type: "object", properties: {} } },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  switch (name) {
    case "echo": return text(`echo: ${args.text}`);
    case "add": return text(String(Number(args.a) + Number(args.b)));
    case "fail": return text("this tool always fails", true);
    case "slow": await new Promise((r) => setTimeout(r, Number(args.ms) || 0)); return text("slept");
    case "whoami_env": return text(`MINI_VAR=${process.env.MINI_VAR ?? "(unset)"}`);
    case "secret_tool": return text("top secret");
    default: return null;
  }
}

/** One JSON-RPC message in, response (or null for notifications) out. */
async function handle(msg) {
  if (msg.id === undefined) return null; // notification
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mini-mcp", version: "1.2.3" },
        instructions: "Mini MCP test server.",
      });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const r = await callTool(msg.params?.name, msg.params?.arguments);
      return r ? ok(r) : err(-32602, `unknown tool ${msg.params?.name}`);
    }
    default: return err(-32601, `method not found: ${msg.method}`);
  }
}

const mode = process.argv[2];

if (mode === "stdio") {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      void handle(JSON.parse(line)).then((res) => res && process.stdout.write(JSON.stringify(res) + "\n"));
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else if (mode === "http") {
  const port = Number(process.argv[3]);
  const token = process.argv[4];
  http
    .createServer((req, res) => {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end(); // no server-initiated SSE stream
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const out = await handle(msg);
        if (!out) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      });
    })
    .listen(port, "127.0.0.1", () => console.log(`mini-mcp http listening on ${port}`));
} else {
  console.error("usage: mini-mcp.mjs stdio | http <port> [token]");
  process.exit(2);
}
