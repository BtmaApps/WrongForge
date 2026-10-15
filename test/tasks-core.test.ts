/**
 * Core task API test (offline: fake Anthropic + the real server).
 *
 *   npx tsx test/tasks-core.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Fake, assert, parseSse, sleep, startHarness } from "./helpers/harness.js";
import { TaskStore } from "../src/tasks/store.js";
import { gzipFile } from "../src/log.js";

const tool = (name: string, input: unknown): string => `[[tool ${name} ${JSON.stringify(input)}]]`;
const types = (events: any[]): string[] => events.map((e) => e.type);

/** Drops cache_control markers (they mark breakpoints, they are not part of the cached content). */
const stripCc = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));

async function main(): Promise<void> {
  const fake = new Fake();
  await fake.start();
  const h = await startHarness({ fake });
  const dirA = h.mkdir("a");
  fs.writeFileSync(path.join(dirA, "hello.txt"), "hi");
  const post = (body: Record<string, unknown>) => h.api("POST", "/v1/tasks", { workdir: dirA, ...body });

  // ============================================================ auth / info
  const health = await fetch(`${h.base}/health`);
  const hb = await health.json();
  assert(health.status === 200 && hb.ok === true && hb.name === "WrongForge", "health needs no key");
  const noKey = await fetch(`${h.base}/v1/info`);
  assert(noKey.status === 401 && (await noKey.json()).error.code === "unauthorized", "401 without key, error envelope");
  assert((await fetch(`${h.base}/v1/info`, { headers: { Authorization: "Bearer wrong-key-wrong-key" } })).status === 401, "401 with a wrong key");
  const info = (await h.api("GET", "/v1/info")).body;
  assert(info.protocol === 1 && info.workdir.required === true && info.default_model === "claude-sonnet-5-5", "info: protocol, workdir required, model");
  assert(info.tools.includes("report_progress") && info.tools.includes("mcp_call") && info.cache.default === "1h", "info lists tools and cache default");
  assert((await h.api("GET", "/v1/tools")).body.tools.some((t: any) => t.name === "bash"), "/v1/tools");
  assert((await h.api("GET", "/v1/nope")).status === 404, "unknown route -> 404");

  // ============================================================ validation
  const bad = async (body: unknown, status: number, code: string, label: string): Promise<void> => {
    const r = await h.api("POST", "/v1/tasks", body);
    assert(r.status === status && r.body.error.code === code, `${label} -> ${status} ${code} (got ${r.status} ${r.body?.error?.code})`);
  };
  await bad({ workdir: dirA }, 400, "invalid_request", "missing prompt");
  await bad({ prompt: "x" }, 400, "workdir_required", "missing workdir");
  await bad({ prompt: "x", workdir: path.join(dirA, "nope") }, 400, "invalid_workdir", "workdir that does not exist");
  await bad({ prompt: "x", workdir: path.join(dirA, "hello.txt") }, 400, "invalid_workdir", "workdir that is a file");
  await bad({ prompt: "x", workdir: dirA, cache: "forever" }, 400, "invalid_request", "bad cache mode");
  await bad({ prompt: "x", workdir: dirA, session_id: "../evil" }, 400, "invalid_request", "path traversal in session_id");
  await bad({ prompt: "x", workdir: dirA, task_id: "a/b" }, 400, "invalid_request", "bad task_id");
  await bad({ prompt: "x", workdir: dirA, model: "bad model!" }, 400, "invalid_request", "bad model");
  await bad({ prompt: "x", workdir: dirA, max_steps: 0 }, 400, "invalid_request", "max_steps 0");
  await bad({ prompt: "x", workdir: dirA, timeout_ms: 5 }, 400, "invalid_request", "timeout too small");
  await bad({ prompt: "x", workdir: dirA, mcp: ["ghost"] }, 400, "unknown_mcp_server", "unknown MCP server");
  await bad({ prompt: "x", workdir: dirA, callback: { url: "ftp://x" } }, 400, "invalid_request", "bad callback url");
  await bad({ prompt: "x", workdir: dirA, env: { "bad-name": "1" } }, 400, "invalid_request", "bad env name");
  await bad({ prompt: "x", workdir: dirA, gateway: { url: "http://example.com" } }, 400, "invalid_gateway", "gateway host not allowed");
  const badJson = await fetch(`${h.base}/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${h.key}`, "Content-Type": "application/json" }, body: "{nope" });
  assert(badJson.status === 400 && (await badJson.json()).error.code === "invalid_json", "invalid JSON body");

  // ============================================================ lifecycle
  const created = await post({ task_id: "life-1", prompt: `${tool("ls", { path: "." })} [[say listing done]]`, context: { ticket: "WS-42" } });
  assert(created.status === 202 && created.body.deduplicated === false, "submit -> 202");
  assert(created.headers.get("location") === "/v1/tasks/life-1", "Location header");
  const t0 = created.body.task;
  assert(t0.id === "life-1" && /^ses_[0-9a-f]{16}$/.test(t0.session_id) && t0.session_created === true, "task id + generated session id");
  assert(t0.workdir === dirA && t0.cache === "1h" && t0.model === "claude-sonnet-5-5" && t0.workdir_lock === false, "record echoes workdir/cache/model/lock");
  assert(JSON.stringify(t0.context) === '{"ticket":"WS-42"}', "context echoed untouched");

  const done = await h.waitTask("life-1");
  assert(done.status === "completed" && done.result.text === "listing done", "completed with the final text");
  assert(done.result.steps === 2 && done.result.tool_calls === 1, "2 steps, 1 tool call");
  assert(done.result.usage.input_tokens > 0 && done.result.context_tokens > 0 && done.result.context_window === 1_000_000, "usage + context size reported");
  assert(typeof done.result.context_percent === "number" && done.result.duration_ms >= 0, "context percent + duration");
  assert(done.started_at && done.finished_at && done.progress.last_event_seq > 5, "timestamps + progress");

  const ev = await h.events("life-1");
  assert(ev.every((e: any, i: number) => e.seq === i + 1), "event seq is gap-free from 1");
  assert(ev.every((e: any) => e.task_id === "life-1" && e.session_id === t0.session_id), "every event carries task_id and session_id");
  assert(types(ev)[0] === "task.queued" && types(ev)[1] === "task.started" && types(ev).at(-1) === "task.completed", "queued -> started -> … -> completed");
  const started = ev.find((e: any) => e.type === "task.started").data;
  assert(started.workdir === dirA && started.model === "claude-sonnet-5-5" && started.cache === "1h", "task.started data");
  const tStart = ev.find((e: any) => e.type === "tool.started");
  const tEnd = ev.find((e: any) => e.type === "tool.finished");
  assert(tStart.data.name === "ls" && tStart.data.input.path === "." && tEnd.data.tool_call_id === tStart.data.tool_call_id, "tool.started / tool.finished pair");
  assert(tEnd.data.ok === true && tEnd.data.output.entries.some((x: any) => x.name === "hello.txt"), "tool output visible, ran in the workdir");
  assert(types(ev).includes("step.started") && types(ev).includes("step.finished") && types(ev).includes("agent.text"), "step + text events");
  assert(ev.find((e: any) => e.type === "agent.text").data.text.includes("listing done"), "agent.text carries the answer");
  assert(ev.find((e: any) => e.type === "step.finished").data.usage.input_tokens > 0, "step.finished carries usage");
  assert(ev.find((e: any) => e.type === "task.queued").data.waiting_for === null, "idle server: waiting_for null");

  const list = (await h.api("GET", "/v1/tasks?status=completed")).body;
  assert(list.tasks.some((t: any) => t.id === "life-1") && !(await h.api("GET", "/v1/tasks?status=running")).body.tasks.some((t: any) => t.id === "life-1"), "list + status filter");
  assert((await h.api("GET", "/v1/tasks?status=bogus")).status === 400, "bad status filter -> 400");
  assert((await h.api("GET", `/v1/tasks?session_id=${t0.session_id}`)).body.tasks.length === 1, "session filter");
  assert((await h.api("GET", "/v1/tasks/ghost")).body.error.code === "task_not_found", "unknown task -> 404 envelope");

  // idempotency
  const again = await post({ task_id: "life-1", prompt: `${tool("ls", { path: "." })} [[say listing done]]` });
  assert(again.status === 200 && again.body.deduplicated === true && again.body.task.status === "completed", "same task_id -> deduplicated, no second run");
  assert(fake.turns().length === 2, "dedup did not call the model again");
  const conflict = await post({ task_id: "life-1", prompt: "something else" });
  assert(conflict.status === 409 && conflict.body.error.code === "task_id_conflict", "same task_id, other prompt -> 409");

  // ============================================================ wait / stream / replay / long-poll
  const waited = await post({ prompt: "[[say waited]]", wait: true });
  assert(waited.status === 200 && waited.body.task.status === "completed" && waited.body.task.result.text === "waited", "wait:true returns the finished task");

  const streamRes = await fetch(`${h.base}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${h.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workdir: dirA, prompt: "[[say streamed]]", stream: true }),
  });
  assert(streamRes.headers.get("content-type")!.includes("text/event-stream"), "stream:true -> SSE");
  const sse = parseSse(await streamRes.text());
  assert(sse[0]!.event === "task.queued" && sse.at(-2)!.event === "task.completed" && sse.at(-1)!.event === "end", "SSE: queued … completed, then end");
  assert(sse.at(-1)!.data.status === "completed" && sse.slice(0, -1).every((e, i) => e.id === String(i + 1)), "SSE: ids are the event seqs");

  const taskId = sse[0]!.data.task_id;
  const replay = await fetch(`${h.base}/v1/tasks/${taskId}/events`, { headers: { Authorization: `Bearer ${h.key}`, Accept: "text/event-stream", "Last-Event-ID": "3" } });
  const rs = parseSse(await replay.text());
  assert(rs[0]!.id === "4" && rs.at(-1)!.event === "end", "SSE replay resumes after Last-Event-ID");
  const replay2 = parseSse(await (await fetch(`${h.base}/v1/tasks/${taskId}/events?stream=1&after=100`, { headers: { Authorization: `Bearer ${h.key}` } })).text());
  assert(replay2.length === 1 && replay2[0]!.event === "end", "nothing after the last seq -> just end");

  const slow = (await post({ task_id: "slow-1", prompt: "[[delay 500]] [[say slow]]" })).body.task;
  await sleep(100);
  const cur = (await h.api("GET", "/v1/tasks/slow-1/events?limit=1000")).body;
  const t1 = Date.now();
  const lp = (await h.api("GET", `/v1/tasks/slow-1/events?after=${cur.next_after}&wait_ms=5000`)).body;
  assert(lp.events.length > 0 && Date.now() - t1 < 4000, `long-poll returns as soon as events arrive (${Date.now() - t1} ms)`);
  assert(slow.id === "slow-1" && (await h.waitTask("slow-1")).status === "completed", "long-poll task finishes");

  // ============================================================ session continuity + prompt cache
  const S = "cache-session";
  const n0 = fake.turns().length;
  const c1 = (await post({ task_id: "c1", session_id: S, prompt: "[[say first answer]]", wait: true })).body.task;
  const c2 = (await post({ task_id: "c2", session_id: S, prompt: "[[say second answer]]", wait: true })).body.task;
  assert(c1.session_id === S && c2.session_id === S && c1.session_created === true && c2.session_created === false, "caller-chosen session id; second task continues it");
  const [r1, r2] = fake.turns().slice(n0);
  assert(r1 && r2, "two model requests captured");
  const m1 = r1!.body.messages, m2 = r2!.body.messages;
  assert(m2.length === m1.length + 2, "second request = first request + assistant answer + new user message");
  assert(JSON.stringify(stripCc(m2.slice(0, m1.length))) === JSON.stringify(stripCc(m1)), "PREFIX STABLE: earlier messages are byte-identical (cache can hit)");
  assert(JSON.stringify(stripCc(m2[m1.length])).includes("first answer"), "the previous answer is part of the history");
  assert(JSON.stringify(r2!.body.system) === JSON.stringify(r1!.body.system), "system prompt identical across tasks of a session");
  assert(JSON.stringify(r2!.body.tools) === JSON.stringify(r1!.body.tools), "tool definitions identical across tasks of a session");
  const sysText = JSON.stringify(r1!.body.system);
  assert(!sysText.includes("task_id: c1") && !sysText.includes("working_directory") && !sysText.includes(dirA.replace(/\\/g, "\\\\")), "system prompt carries no task id and no path");
  assert(JSON.stringify(m1[0]).includes("task_id: c1") && JSON.stringify(m1[0]).includes(`working_directory: ${dirA.replace(/\\/g, "\\\\")}`), "task id + workdir travel in the user message");
  const sysLast = r1!.body.system.at(-1);
  assert(sysLast.cache_control?.type === "ephemeral" && sysLast.cache_control.ttl === "1h", "cache breakpoint 1: last system block, ttl 1h");
  const lastBlock = m1.at(-1).content.at(-1);
  assert(lastBlock.cache_control?.type === "ephemeral" && lastBlock.cache_control.ttl === "1h", "cache breakpoint 2: last block of the last message");
  const countCc = (o: unknown): number => (JSON.stringify(o).match(/cache_control/g) ?? []).length;
  assert(countCc(r2!.body) === 2, "exactly 2 breakpoints (limit is 4)");

  const off = (await post({ session_id: S, prompt: "[[say x]]", cache: "off", wait: true })).body.task;
  assert(countCc(fake.turns().at(-1)!.body) === 0 && off.cache === "off", 'cache:"off" sends no cache_control');
  await post({ session_id: S, prompt: "[[say y]]", cache: "5m", wait: true });
  const five = fake.turns().at(-1)!.body;
  assert(countCc(five) === 2 && !JSON.stringify(five).includes('"ttl"'), 'cache:"5m" uses the default lifetime (no ttl field)');

  const sess = (await h.api("GET", `/v1/sessions/${S}`)).body;
  assert(sess.session.turns === 4 && sess.session.workdir === dirA && sess.session.title === "[[say first answer]]", "session meta: turns, workdir, title");
  assert(sess.session.context_tokens > 0 && sess.session.compactions === 0 && sess.in_use === false, "session meta: context tokens measured, not in use");
  const pg = (await h.api("GET", `/v1/sessions/${S}/messages?offset=0&limit=2`)).body;
  assert(pg.messages.length === 2 && pg.total === sess.session.message_count, "messages endpoint paginates");

  // continuing after a server restart (new process state, same data directory)
  const home = h.home;
  await h.close();
  const h2 = await startHarness({ home, fake });
  const before = fake.turns().length;
  const after = (await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: S, prompt: "[[say after restart]]", wait: true })).body.task;
  assert(after.status === "completed" && after.session_created === false, "session continues after a restart");
  const rr = fake.turns()[before]!.body.messages;
  assert(rr.length > m2.length, "restarted server sends the stored history, then the new message");
  assert(JSON.stringify(rr).includes("first answer") && JSON.stringify(rr).includes("second answer"), "history survived the restart (messages.jsonl)");
  assert((await h2.api("GET", `/v1/tasks/life-1`)).body.task.status === "completed", "finished tasks survive the restart");
  assert((await h2.events("life-1")).length === ev.length, "event log survives the restart");

  // ============================================================ model passthrough
  await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say m]]", model: "claude-opus-5-5", wait: true });
  assert(fake.turns().at(-1)!.body.model === "claude-opus-5-5", "task.model is what the API receives");
  await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say m]]", wait: true });
  assert(fake.turns().at(-1)!.body.model === "claude-sonnet-5-5", "default model otherwise");

  // ============================================================ report_progress + todos
  const rp = (await h2.api("POST", "/v1/tasks", {
    workdir: dirA,
    wait: true,
    prompt: `${tool("report_progress", { message: "halfway there", percent: 50, phase: "implementing" })} ${tool("todo_write", { todos: [{ content: "step one", status: "in_progress" }, { content: "step two", status: "pending" }] })}`,
  })).body.task;
  const rev = await h2.events(rp.id);
  const rep = rev.find((e: any) => e.type === "agent.report");
  assert(rep && rep.data.message === "halfway there" && rep.data.percent === 50 && rep.data.phase === "implementing", "agent.report event");
  assert(!rev.some((e: any) => e.type === "tool.started" && e.data.name === "report_progress"), "report_progress is not duplicated as a tool event");
  assert(rev.find((e: any) => e.type === "agent.todos").data.todos.length === 2, "agent.todos event");
  assert(rp.progress.last_report.message === "halfway there" && rp.progress.todos.length === 2, "progress snapshot holds the last report and todos");
  assert(rp.progress.tool_calls === 2, "report_progress still counts as a tool call");

  // ============================================================ max_steps / API failure
  const ms = (await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: "ms-sess", prompt: tool("ls", { path: "." }), max_steps: 1, wait: true })).body.task;
  assert(ms.status === "failed" && ms.error.code === "max_steps" && ms.result.steps === 1, "step limit -> failed/max_steps with the partial result");
  assert((await h2.api("GET", "/v1/sessions/ms-sess")).body.session.turns === 1, "partial work is committed to the session so the caller can continue");

  const fl = (await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: "fail-sess", prompt: "[[fail 400 this request is broken]]", wait: true })).body.task;
  assert(fl.status === "failed" && fl.error.code === "agent_error" && fl.error.message.includes("this request is broken"), "API error -> failed/agent_error with the API's message");
  assert((await h2.api("GET", "/v1/sessions/fail-sess")).body.session.turns === 0, "a failed task leaves the session untouched");

  // ============================================================ sessions API
  assert((await h2.api("POST", "/v1/sessions", { id: "custom-1" })).status === 201, "create session with a chosen id");
  assert((await h2.api("POST", "/v1/sessions", { id: "custom-1" })).status === 409, "creating it twice -> 409");
  assert((await h2.api("POST", "/v1/sessions", { id: "bad id" })).status === 400, "invalid session id -> 400");
  assert((await h2.api("GET", "/v1/sessions/ghost")).body.error.code === "session_not_found", "unknown session -> 404");
  const gen = (await h2.api("POST", "/v1/sessions", {})).body.session;
  assert(/^ses_/.test(gen.id), "session id generated when omitted");
  const cp = (await h2.api("POST", "/v1/sessions/custom-1/compact", {})).body;
  assert(cp.compacted === false && cp.turns_summarized === 0, "compacting a tiny session is a no-op");
  assert((await h2.api("POST", "/v1/sessions/ghost/compact", {})).status === 404, "compact unknown -> 404");
  await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: "busy-1", prompt: "[[delay 600]] [[say b]]" });
  await sleep(100);
  assert((await h2.api("DELETE", "/v1/sessions/busy-1")).status === 409, "deleting a busy session -> 409");
  assert((await h2.api("POST", "/v1/sessions/busy-1/compact", {})).status === 409, "compacting a busy session -> 409");
  assert((await h2.api("GET", "/v1/sessions/busy-1")).body.in_use === true, "in_use flag");
  await h2.waitTask((await h2.api("GET", "/v1/tasks?session_id=busy-1")).body.tasks[0].id);
  assert((await h2.api("DELETE", "/v1/sessions/busy-1")).status === 200 && (await h2.api("GET", "/v1/sessions/busy-1")).status === 404, "delete after it finished");

  // ============================================================ crash recovery (seeded)
  await h2.close();
  const home3 = path.join(home, "recovery");
  const seed = new TaskStore(path.join(home3, "tasks"));
  const now = new Date().toISOString();
  seed.put({
    id: "crashed-1", status: "running", session_id: "s-crash", session_created: true, prompt: "p", model: "m", max_steps: 5, timeout_ms: 5000,
    cache: "1h", workdir: dirA, workdir_lock: false, env_keys: [], created_at: now, started_at: now,
    progress: { last_event_seq: 3, steps: 1, tool_calls: 0, last_activity_at: now },
  });
  for (const [i, type] of ["task.queued", "task.started", "step.started"].entries()) {
    seed.appendEvent({ seq: i + 1, ts: now, task_id: "crashed-1", session_id: "s-crash", type: type as never, data: {} });
  }
  const h3 = await startHarness({ home: home3, fake });
  const crashed = (await h3.api("GET", "/v1/tasks/crashed-1")).body.task;
  assert(crashed.status === "failed" && crashed.error.code === "server_restarted", "leftover running task -> failed/server_restarted");
  const cev = await h3.events("crashed-1");
  assert(cev.length === 4 && cev[3].seq === 4 && cev[3].type === "task.failed" && cev[3].data.error.code === "server_restarted", "terminal event continues the seq after the crash");

  // ============================================================ maintenance endpoint
  const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const mk = (id: string, finishedDaysAgo: number) => {
    h3.app.taskStore.put({
      id, status: "completed", session_id: "s-old", session_created: false, prompt: "p", model: "m", max_steps: 5, timeout_ms: 5000, cache: "1h",
      workdir: dirA, workdir_lock: false, env_keys: [], created_at: old(finishedDaysAgo + 1), finished_at: old(finishedDaysAgo),
      progress: { last_event_seq: 1, steps: 0, tool_calls: 0, last_activity_at: old(finishedDaysAgo) },
    });
    h3.app.taskStore.appendEvent({ seq: 1, ts: old(finishedDaysAgo), task_id: id, session_id: "s-old", type: "task.completed", data: { marker: id } });
  };
  mk("ancient-1", 200); // beyond the 90-day retention
  mk("middle-1", 10); // beyond the 3-day compression age
  mk("fresh-1", 0);
  const mnt = await h3.api("POST", "/v1/maintenance/run");
  assert(mnt.status === 200 && mnt.body.tasks.deleted.includes("ancient-1") && mnt.body.tasks.compressed.includes("middle-1"), "maintenance: old task deleted, middle one compressed");
  assert((await h3.api("GET", "/v1/tasks/ancient-1")).status === 404, "deleted task is gone");
  const comp = await h3.events("middle-1");
  assert(comp.length === 1 && comp[0].data.marker === "middle-1", "compressed event log is still readable through the API");
  assert(fs.existsSync(path.join(home3, "tasks", "middle-1", "events.jsonl.gz")) && !fs.existsSync(path.join(home3, "tasks", "middle-1", "events.jsonl")), "events.jsonl became events.jsonl.gz");
  assert(!mnt.body.tasks.compressed.includes("fresh-1") && !mnt.body.tasks.deleted.includes("fresh-1"), "fresh task untouched");
  void gzipFile;

  await h3.close();
  await fake.close();
  console.log("TASKS CORE TESTS PASSED ✓ (auth, validation, lifecycle, events, idempotency, wait/stream/replay/long-poll, sessions, cache prefix stability, restart continuity, recovery, maintenance)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
