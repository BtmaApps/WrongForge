/**
 * Concurrency, isolation, queueing, cancel/timeout, webhooks.
 *
 *   npx tsx test/tasks-concurrency.test.ts
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { WebhookDispatcher, type DeliveryResult } from "../src/tasks/webhook.js";
import type { TaskEvent } from "../src/tasks/types.js";
import { assert, sleep, startHarness, startReceiver, type Harness } from "./helpers/harness.js";

const tool = (name: string, input: unknown): string => `[[tool ${name} ${JSON.stringify(input)}]]`;
const norm = (p: string): string => path.resolve(p.trim()).toLowerCase();
const ms = (iso: string): number => Date.parse(iso);

async function submit(h: Harness, body: Record<string, unknown>): Promise<any> {
  const r = await h.api("POST", "/v1/tasks", body);
  assert(r.status === 202 || r.status === 200, `submit failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.task;
}

async function waitFor(cond: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(25);
  }
}

async function main(): Promise<void> {
  // =============================================================== parallel isolation
  {
    const h = await startHarness({ app: { maxConcurrency: 4 } });
    const dA = h.mkdir("pa");
    const dB = h.mkdir("pb");
    const prompt = (mark: string): string =>
      [
        tool("write", { path: "out.txt", content: mark }),
        tool("bash", { command: 'node -e "console.log(process.cwd())"' }),
        tool("todo_write", { todos: [{ content: `todo-${mark}`, status: "pending" }] }),
        tool("glob", { pattern: "*.txt" }),
        `[[delay 400]] [[say ${mark} done]]`,
      ].join(" ");

    const a = await submit(h, { workdir: dA, prompt: prompt("AAA"), env: { WSTACK_TASK: "t-secret-123" } });
    const b = await submit(h, { workdir: dB, prompt: prompt("BBB") });
    const [ra, rb] = [await h.waitTask(a.id), await h.waitTask(b.id)];
    assert(ra.status === "completed" && rb.status === "completed", `both tasks completed (${ra.status}/${rb.status} ${JSON.stringify(ra.error ?? rb.error)})`);
    assert(ms(ra.started_at) < ms(rb.finished_at) && ms(rb.started_at) < ms(ra.finished_at), "the two tasks really ran at the same time");
    assert(fs.readFileSync(path.join(dA, "out.txt"), "utf8") === "AAA", "relative write landed in workdir A");
    assert(fs.readFileSync(path.join(dB, "out.txt"), "utf8") === "BBB", "relative write landed in workdir B");
    for (const [t, dir, mark] of [[a, dA, "AAA"], [b, dB, "BBB"]] as const) {
      const ev = await h.events(t.id);
      const sh = ev.find((e: any) => e.type === "tool.finished" && e.data.name === "bash");
      assert(norm(sh.data.output.stdout) === norm(dir), `bash ran with cwd = its own workdir (${mark})`);
      const gl = ev.find((e: any) => e.type === "tool.finished" && e.data.name === "glob");
      assert(JSON.stringify(gl.data.output).includes("out.txt") && gl.data.output.files?.length === 1, `glob saw only its own directory (${mark})`);
      const td = ev.find((e: any) => e.type === "agent.todos");
      assert(td.data.todos.length === 1 && td.data.todos[0].content === `todo-${mark}`, `todo list is per task (${mark})`);
    }
    // env: values go to the shell, only names are stored
    const aEv = await h.events(a.id);
    const sh = aEv.find((e: any) => e.type === "tool.finished" && e.data.name === "bash");
    assert(norm(sh.data.output.stdout) === norm(dA), "(sanity) bash output");
    const withEnv = await submit(h, { workdir: dA, env: { WSTACK_TASK: "t-secret-123" }, prompt: tool("bash", { command: 'node -e "console.log(process.env.WSTACK_TASK)"' }) });
    await h.waitTask(withEnv.id);
    const envEv = (await h.events(withEnv.id)).find((e: any) => e.type === "tool.finished" && e.data.name === "bash");
    assert(envEv.data.output.stdout.trim() === "t-secret-123", "task env reaches the shell");
    const recJson = fs.readFileSync(path.join(h.home, "tasks", withEnv.id, "task.json"), "utf8");
    assert(!recJson.includes("t-secret-123") && JSON.parse(recJson).env_keys.join() === "WSTACK_TASK", "env VALUES are never persisted, only names");

    // heartbeat
    const hb = await submit(h, { workdir: dA, prompt: "[[delay 800]] [[say hb]]" });
    await h.waitTask(hb.id);
    const beats = (await h.events(hb.id)).filter((e: any) => e.type === "task.heartbeat");
    assert(beats.length >= 2 && beats[1].data.elapsed_ms > beats[0].data.elapsed_ms, `heartbeats while running (${beats.length})`);
    assert(typeof beats[0].data.steps === "number" && "current_tool" in beats[0].data, "heartbeat carries steps + current tool");
    await h.close();
  }

  // =============================================================== queue, sessions, locks
  {
    const h = await startHarness({ app: { maxConcurrency: 1, defaultWorkdir: undefined } });
    const d = h.mkdir("q");
    const t1 = await submit(h, { workdir: d, prompt: "[[delay 600]] [[say one]]" });
    const t2 = await submit(h, { workdir: d, prompt: "[[say two]]" });
    const t3 = await submit(h, { workdir: d, prompt: "[[say three]]" });
    const health = (await fetch(`${h.base}/health`).then((r) => r.json())) as any;
    assert(health.running === 1 && health.queued === 2, `health shows the queue (${health.running} running, ${health.queued} queued)`);
    assert((await h.events(t2.id))[0].data.waiting_for === "capacity" && (await h.events(t2.id))[0].data.position === 0, "queued event says why it waits: capacity");

    // cancel a QUEUED task: immediate, never started
    const c3 = await h.api("POST", `/v1/tasks/${t3.id}/cancel`, { reason: "not needed" });
    assert(c3.body.task.status === "cancelled" && c3.body.already_finished === false && !c3.body.task.started_at, "queued task cancelled without ever running");
    assert(c3.body.task.cancel_reason === "not needed", "cancel reason kept");

    const [r1, r2] = [await h.waitTask(t1.id), await h.waitTask(t2.id)];
    assert(ms(r2.started_at) >= ms(r1.finished_at), "capacity 1: the second task starts after the first finished");
    assert(r2.result.text === "two", "queued task ran normally");
    assert((await h.api("POST", `/v1/tasks/${t3.id}/cancel`, {})).body.already_finished === true, "cancelling a finished task is idempotent");
    assert((await h.api("POST", "/v1/tasks/ghost/cancel", {})).status === 404, "cancel unknown -> 404");

    // default workdir: optional when the server has one
    await h.close();
  }
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-dw-"));
    const dflt = path.join(home, "work", "default");
    fs.mkdirSync(dflt, { recursive: true });
    const h = await startHarness({ home, app: { defaultWorkdir: dflt } });
    const info = (await h.api("GET", "/v1/info")).body;
    assert(info.workdir.required === false && info.workdir.default === dflt, "info: default workdir configured");
    const t = (await h.api("POST", "/v1/tasks", { prompt: "[[say hi]]", wait: true })).body.task;
    assert(t.status === "completed" && t.workdir === fs.realpathSync(dflt), "task without workdir uses the server default");
    const rel = (await h.api("POST", "/v1/tasks", { prompt: "[[say hi]]", workdir: ".", wait: true })).body.task;
    assert(rel.workdir === fs.realpathSync(dflt), "a relative workdir resolves against the default");
    await h.close();
  }
  {
    const h = await startHarness({ app: { maxConcurrency: 4 } });
    const d = h.mkdir("l");

    // same session -> strictly serialized, in order, history carried
    const S = "serial-sess";
    const s1 = await submit(h, { workdir: d, session_id: S, prompt: "[[delay 400]] [[say first]]" });
    const s2 = await submit(h, { workdir: d, session_id: S, prompt: "[[say second]]" });
    assert((await h.events(s2.id))[0].data.waiting_for === "session", "same session: waiting_for session");
    const [x1, x2] = [await h.waitTask(s1.id), await h.waitTask(s2.id)];
    assert(ms(x2.started_at) >= ms(x1.finished_at), "same session: second waits for the first");
    assert(JSON.stringify(h.fake.turns().at(-1)!.body.messages).includes("first"), "same session: the second task saw the first one's answer");

    // no lock: parallel in one directory
    const p1 = await submit(h, { workdir: d, prompt: "[[delay 500]] [[say p1]]" });
    const p2 = await submit(h, { workdir: d, prompt: "[[delay 500]] [[say p2]]" });
    const [y1, y2] = [await h.waitTask(p1.id), await h.waitTask(p2.id)];
    assert(ms(y2.started_at) < ms(y1.finished_at), "no lock: two tasks share a workdir concurrently");

    // lock: exclusive
    const k1 = await submit(h, { workdir: d, workdir_lock: true, prompt: "[[delay 400]] [[say k1]]" });
    const k2 = await submit(h, { workdir: d, prompt: "[[say k2]]" });
    assert((await h.events(k2.id))[0].data.waiting_for === "workdir", "locked workdir: waiting_for workdir");
    const [z1, z2] = [await h.waitTask(k1.id), await h.waitTask(k2.id)];
    assert(ms(z2.started_at) >= ms(z1.finished_at), "workdir lock: the other task waits");
    assert(z1.workdir_lock === true, "lock flag is on the record");

    // a locked task is not starved by tasks that arrive later
    const r1 = await submit(h, { workdir: d, prompt: "[[delay 500]] [[say r1]]" });
    const r2 = await submit(h, { workdir: d, workdir_lock: true, prompt: "[[delay 200]] [[say r2]]" });
    const r3 = await submit(h, { workdir: d, prompt: "[[say r3]]" });
    const [w1, w2, w3] = [await h.waitTask(r1.id), await h.waitTask(r2.id), await h.waitTask(r3.id)];
    assert(ms(w2.started_at) >= ms(w1.finished_at), "lock waits for the running task");
    assert(ms(w3.started_at) >= ms(w2.finished_at), "no starvation: a later task does not jump ahead of the waiting locked one");

    // different directories never block each other even with locks
    const e1 = await submit(h, { workdir: h.mkdir("e1"), workdir_lock: true, prompt: "[[delay 500]] [[say e1]]" });
    const e2 = await submit(h, { workdir: h.mkdir("e2"), workdir_lock: true, prompt: "[[delay 500]] [[say e2]]" });
    const [v1, v2] = [await h.waitTask(e1.id), await h.waitTask(e2.id)];
    assert(ms(v2.started_at) < ms(v1.finished_at), "locks are per directory");

    // ============================================================ cancel / timeout
    const c = await submit(h, { workdir: d, prompt: "[[delay 5000]] [[say never]]" });
    await waitFor(async () => (await h.api("GET", `/v1/tasks/${c.id}`)).body.task.status === "running", "task running");
    const t0 = Date.now();
    const cr = await h.api("POST", `/v1/tasks/${c.id}/cancel`, { reason: "because" });
    assert(cr.body.task.status === "cancelled" && cr.body.task.cancel_reason === "because" && Date.now() - t0 < 3000, `running task cancelled quickly (${Date.now() - t0} ms)`);
    const cev = await h.events(c.id);
    assert(cev.at(-1).type === "task.cancelled" && cev.at(-1).data.reason === "because", "terminal event task.cancelled with the reason");
    assert((await h.api("GET", `/v1/sessions/${c.session_id}`)).body.session.turns === 0, "a cancelled task leaves the session untouched");

    const to = await submit(h, { workdir: d, timeout_ms: 1000, prompt: "[[delay 6000]] [[say never]]" });
    const tt0 = Date.now();
    const tdone = await h.waitTask(to.id);
    assert(tdone.status === "timed_out" && Date.now() - tt0 < 5000, `timeout_ms stops the task (${Date.now() - tt0} ms)`);
    assert((await h.events(to.id)).at(-1).type === "task.timed_out" && (await h.events(to.id)).at(-1).data.timeout_ms === 1000, "terminal event task.timed_out");

    const sh = await submit(h, { workdir: d, prompt: tool("bash", { command: 'node -e "setTimeout(()=>{},60000)"' }) });
    await waitFor(async () => (await h.events(sh.id)).some((e: any) => e.type === "tool.started"), "shell command started");
    const st0 = Date.now();
    const sc = await h.api("POST", `/v1/tasks/${sh.id}/cancel`, {});
    assert(sc.body.task.status === "cancelled" && Date.now() - st0 < 6000, `cancel also kills the running shell command (${Date.now() - st0} ms)`);
    await h.close();
  }

  // =============================================================== allowed roots
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-roots-"));
    const root = path.join(home, "work");
    fs.mkdirSync(path.join(root, "inside"), { recursive: true });
    const h = await startHarness({ home, app: { allowedRoots: [root] } });
    const post = (workdir: string) => h.api("POST", "/v1/tasks", { workdir, prompt: "[[say x]]" });
    assert((await post(path.join(root, "inside"))).status === 202, "workdir inside the allowed root");
    assert((await post(root)).status === 202, "the root itself is allowed");
    const out = await post(home);
    assert(out.status === 403 && out.body.error.code === "workdir_not_allowed", "workdir outside the roots -> 403");
    assert((await post(path.join(root, "inside", "..", ".."))).status === 403, '".." cannot climb out of the root');
    try {
      fs.symlinkSync(home, path.join(root, "escape"), "junction");
      const via = await post(path.join(root, "escape"));
      assert(via.status === 403, "a link that points outside the root is refused (realpath check)");
    } catch (e) {
      if ((e as Error).message.startsWith("assertion")) throw e;
      console.log("  (skipped the symlink check: cannot create a link here)");
    }
    await h.close();
  }

  // =============================================================== webhooks
  {
    const h = await startHarness({ app: { maxConcurrency: 4 } });
    const d = h.mkdir("w");
    let failedOnce = false;
    const rcv = await startReceiver((r, res) => {
      if (r.headers["x-wrongforge-event"] === "step.started" && !failedOnce) {
        failedOnce = true;
        res.writeHead(500).end("boom");
        return;
      }
      res.writeHead(200).end("ok");
    });

    const t = await submit(h, { workdir: d, prompt: `${tool("ls", { path: "." })} [[say hooked]]`, callback: { url: rcv.url } });
    await h.waitTask(t.id);
    await h.app.webhook.idle();
    await sleep(150); // callback_stats are saved with a short debounce

    const all = rcv.received;
    const evTypes = all.map((r) => r.json.type);
    assert(evTypes[0] === "task.queued" && evTypes.at(-1) === "task.completed", "webhooks: first task.queued, last task.completed");
    assert(!evTypes.includes("agent.text"), "default filter leaves out agent.text");
    assert(evTypes.includes("tool.started") && evTypes.includes("tool.finished") && evTypes.includes("step.finished"), "tool + step events delivered");
    const seqs = all.map((r) => r.json.seq);
    assert(seqs.every((s, i) => i === 0 || s >= seqs[i - 1]!), "delivered strictly in seq order (a retry blocks the ones behind it)");

    const retried = all.filter((r) => r.json.type === "step.started");
    assert(retried.length >= 2 && retried[0]!.headers["x-wrongforge-attempt"] === "1" && retried[1]!.headers["x-wrongforge-attempt"] === "2", "a 500 is retried (attempt 1, then 2)");
    assert(retried[0]!.headers["x-wrongforge-delivery"] === retried[1]!.headers["x-wrongforge-delivery"], "the delivery id stays the same across retries (de-duplication key)");

    for (const r of all) {
      const ts = String(r.headers["x-wrongforge-timestamp"]);
      const expected = "sha256=" + crypto.createHmac("sha256", h.key).update(`${ts}.${r.raw}`).digest("hex");
      assert(r.headers["x-wrongforge-signature"] === expected, `valid HMAC signature (seq ${r.json.seq})`);
      assert(r.headers["x-wrongforge-task"] === t.id && r.headers["x-wrongforge-seq"] === String(r.json.seq) && r.headers["x-wrongforge-event"] === r.json.type, "event headers match the body");
      assert(r.headers["content-type"] === "application/json" && String(r.headers["user-agent"]).startsWith("WrongForge/"), "content-type + user-agent");
    }
    assert(Math.abs(Date.now() / 1000 - Number(all[0]!.headers["x-wrongforge-timestamp"])) < 60, "timestamp is current (replay protection)");
    const stats = (await h.api("GET", `/v1/tasks/${t.id}`)).body.task.callback_stats;
    assert(stats.delivered > 0 && stats.failed === 0, `callback_stats: delivered ${stats.delivered}, failed ${stats.failed}`);

    // filters
    rcv.received.length = 0;
    const only = await submit(h, { workdir: d, prompt: "[[say x]]", callback: { url: rcv.url, events: ["task.completed"] } });
    await h.waitTask(only.id);
    await h.app.webhook.idle();
    assert(rcv.received.length === 1 && rcv.received[0]!.json.type === "task.completed", "callback.events: exact type filter");
    rcv.received.length = 0;
    const star = await submit(h, { workdir: d, prompt: "[[say streaming text]]", callback: { url: rcv.url, events: ["*"] } });
    await h.waitTask(star.id);
    await h.app.webhook.idle();
    assert(rcv.received.some((r) => r.json.type === "agent.text" && r.json.data.text.includes("streaming text")), 'callback.events ["*"] includes agent.text');
    rcv.received.length = 0;
    const wild = await submit(h, { workdir: d, prompt: "[[say x]]", callback: { url: rcv.url, events: ["task.*"] } });
    await h.waitTask(wild.id);
    await h.app.webhook.idle();
    assert(rcv.received.every((r) => r.json.type.startsWith("task.")) && rcv.received.length >= 3, 'callback.events ["task.*"] prefix wildcard');
    await rcv.close();

    // receiver rejects permanently (400): no retries, task unaffected
    const rej = await startReceiver((_r, res) => void res.writeHead(400).end("no"));
    const perm = await submit(h, { workdir: d, prompt: "[[say x]]", callback: { url: rej.url, events: ["task.completed", "task.started"] } });
    const permDone = await h.waitTask(perm.id);
    await h.app.webhook.idle();
    assert(permDone.status === "completed", "task completes even though the receiver rejects every event");
    assert(rej.received.length === 2 && rej.received.every((r) => r.headers["x-wrongforge-attempt"] === "1"), "a 4xx is not retried");
    await sleep(150);
    const ps = (await h.api("GET", `/v1/tasks/${perm.id}`)).body.task.callback_stats;
    assert(ps.failed === 2 && ps.delivered === 0 && ps.last_error === "HTTP 400", "callback_stats records the failures");
    await rej.close();

    // receiver is down: retried, then given up, task unaffected
    const down = await submit(h, { workdir: d, prompt: "[[say x]]", callback: { url: "http://127.0.0.1:1/hook", events: ["task.completed"] } });
    const downDone = await h.waitTask(down.id);
    await h.app.webhook.idle();
    await sleep(150);
    assert(downDone.status === "completed", "task completes with an unreachable receiver");
    assert((await h.api("GET", `/v1/tasks/${down.id}`)).body.task.callback_stats.failed === 1, "unreachable receiver: counted as failed after the retries");

    // global live feed
    const feed = await fetch(`${h.base}/v1/events?session_id=feed-sess`, { headers: { Authorization: `Bearer ${h.key}` } });
    const reader = feed.body!.getReader();
    let feedText = "";
    const reading = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        feedText += dec.decode(value, { stream: true });
        if (feedText.includes("event: task.completed")) return;
      }
    })();
    await sleep(100);
    await submit(h, { workdir: d, session_id: "feed-sess", prompt: "[[say live]]" });
    const other = await submit(h, { workdir: d, session_id: "other-sess", prompt: "[[say not for the feed]]" });
    await Promise.race([reading, sleep(8000)]);
    await h.waitTask(other.id);
    await reader.cancel();
    assert(["task.queued", "task.started", "task.completed"].every((t) => feedText.includes(`event: ${t}`)), "GET /v1/events streams live events");
    assert(feedText.includes("feed-sess") && !feedText.includes("other-sess"), "the session filter keeps other sessions' events out");
    await h.close();
  }

  // Closing during retry backoff cancels both the retry and queued followers.
  {
    let calls = 0;
    let retrying!: () => void;
    const reachedBackoff = new Promise<void>((r) => { retrying = r; });
    const results: DeliveryResult[] = [];
    const dispatcher = new WebhookDispatcher({
      key: "shutdown-test-key", baseDelayMs: 60_000,
      fetchImpl: async () => { calls++; return new Response("retry", { status: 500 }); },
      logger: { warn: (type: string) => { if (type === "webhook.retry") retrying(); } } as never,
    });
    const ev: TaskEvent = { task_id: "shutdown-task", session_id: "shutdown-session", seq: 1, ts: new Date().toISOString(), type: "task.completed", data: {} };
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      dispatcher.enqueue({ url: "http://127.0.0.1/hook" }, ev, (r) => results.push(r));
      dispatcher.enqueue({ url: "http://127.0.0.1/hook" }, { ...ev, seq: 2 }, (r) => results.push(r));
      await reachedBackoff;
      assert(typeof dispatcher.close === "function", "webhook dispatcher exposes shutdown");
      await dispatcher.close(); // must resolve without advancing the 60-second backoff
      assert(calls === 1 && results.length === 2 && results.every((r) => !r.ok), "close cancels retry and queued follower without another request");
      dispatcher.enqueue({ url: "http://127.0.0.1/hook" }, { ...ev, seq: 3 }, (r) => results.push(r));
      assert(results.length === 3 && results[2]!.attempts === 0, "closed dispatcher refuses new deliveries synchronously");
      mock.timers.tick(120_000);
      await dispatcher.idle();
      assert(calls === 1, "closed dispatcher never resumes retries");
      await dispatcher.close(); // repeated close is harmless
    } finally {
      mock.timers.reset();
    }
  }

  console.log("TASKS CONCURRENCY TESTS PASSED ✓ (parallel isolation, env, heartbeat, queue, sessions, locks, no starvation, cancel, timeout, allowed roots, webhooks, shutdown, live feed)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
