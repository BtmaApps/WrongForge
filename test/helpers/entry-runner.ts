/**
 * Child runner for the server entry: starts the REAL serve entry in-process
 * (startEnvServer), exercises it and shuts down cleanly so V8 coverage is
 * flushed. Driven by test/cli.test.ts; expects the mock Anthropic env.
 */
import { startEnvServer } from "../src/server.js";

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

await started.shutdown();
console.log("ENTRY-OK");
process.exit(0);
