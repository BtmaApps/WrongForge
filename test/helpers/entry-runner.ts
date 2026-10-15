/**
 * Child runner for the server entry: starts the REAL serve entry in-process
 * (startEnvServer), exercises it and shuts down cleanly so V8 coverage is
 * flushed. Driven by test/cli.test.ts; expects the mock Anthropic env.
 */
import { startEnvServer } from "../../src/server.js";

const key = process.env.AGENT_API_KEY ?? "";
const started = await startEnvServer();
const base = `http://127.0.0.1:${started.port}`;

const health = await fetch(`${base}/health`);
if (!(health.status === 200 && (await health.json()).ok === true)) throw new Error("health failed");

const task = await fetch(`${base}/v1/tasks`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "say exactly OK", workdir: process.env.WF_ENTRY_WORKDIR ?? "." }),
});
if (task.status !== 202) throw new Error(`task submit failed: ${task.status}`);
const tid = ((await task.json()) as { task: { id: string } }).task.id;

let final: { status: string; result?: { text?: string } } | undefined;
for (let i = 0; i < 100 && !final; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const t = await fetch(`${base}/v1/tasks/${tid}`, { headers: { Authorization: `Bearer ${key}` } });
  const j = (await t.json()) as { task: { status: string; result?: { text?: string } } };
  if (["completed", "failed", "cancelled", "timed_out"].includes(j.task.status)) final = j.task;
}
if (final?.status !== "completed" || final.result?.text !== "OK") {
  throw new Error(`task did not complete: ${JSON.stringify(final).slice(0, 200)}`);
}

const usage = await fetch(`${base}/v1/usage`, { headers: { Authorization: `Bearer ${key}` } });
if (!(usage.status === 200 && ((await usage.json()) as { five_hour: { percent: number } }).five_hour.percent === 10)) {
  throw new Error("usage endpoint failed");
}

// ---- MCP configuration routes (against the stdio mini-mcp fixture) ----
const fixture = new URL("../../fixtures/mini-mcp.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const put = await fetch(`${base}/v1/mcp/servers/mini?test=1`, {
  method: "PUT",
  headers: auth,
  body: JSON.stringify({ command: process.execPath, args: [fixture] }),
});
if (![200, 201].includes(put.status)) throw new Error(`mcp put failed: ${put.status} ${await put.text()}`);
const list = await fetch(`${base}/v1/mcp/servers`, { headers: auth });
if (!(list.status === 200 && (await list.text()).includes("mini"))) throw new Error("mcp list failed");
const imp = await fetch(`${base}/v1/mcp/import`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ mcpServers: { imp1: { command: "node" } }, overwrite: false }),
});
if (imp.status !== 200) throw new Error("mcp import failed");
const toolsAll = await fetch(`${base}/v1/mcp/servers/mini/tools`, { headers: auth });
if (toolsAll.status !== 200) throw new Error(`mcp tools failed: ${toolsAll.status}`);
const toolsOne = await fetch(`${base}/v1/mcp/servers/mini/tools?tool=echo`, { headers: auth });
if (toolsOne.status !== 200 && toolsOne.status !== 404) throw new Error("mcp tools?tool failed");
const toolsMiss = await fetch(`${base}/v1/mcp/servers/mini/tools?tool=nope`, { headers: auth });
if (toolsMiss.status !== 404) throw new Error("mcp tools?tool=nope should 404");
const enable = await fetch(`${base}/v1/mcp/servers/imp1/enable`, { method: "POST", headers: auth });
if (enable.status !== 200) throw new Error("mcp enable failed");
const disable = await fetch(`${base}/v1/mcp/servers/imp1/disable`, { method: "POST", headers: auth });
if (disable.status !== 200) throw new Error("mcp disable failed");
const del = await fetch(`${base}/v1/mcp/servers/imp1`, { method: "DELETE", headers: auth });
if (del.status !== 200) throw new Error("mcp delete failed");
const delMiss = await fetch(`${base}/v1/mcp/servers/ghost`, { method: "DELETE", headers: auth });
if (delMiss.status !== 404) throw new Error("mcp delete unknown should 404");
const testSrv = await fetch(`${base}/v1/mcp/servers/mini/test`, { method: "POST", headers: auth });
if (testSrv.status !== 200) throw new Error("mcp test failed");

// ---- misc routes ----
const toolsList = await fetch(`${base}/v1/tools`, { headers: auth });
if (toolsList.status !== 200) throw new Error("/v1/tools failed");
const info = await fetch(`${base}/v1/info`, { headers: auth });
if (info.status !== 200) throw new Error("/v1/info failed");
const unauthorized = await fetch(`${base}/v1/tools`);
if (unauthorized.status !== 401) throw new Error("auth required failed");

// oversized body -> 413
const big = await fetch(`${base}/v1/tasks`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ prompt: "x".repeat(3 * 1024 * 1024) }),
});
if (big.status !== 413) throw new Error(`oversized body should 413, got ${big.status}`);

await started.shutdown();
console.log("ENTRY-OK");
setTimeout(() => process.exit(0), 3_000).unref(); // natural exit flushes coverage
