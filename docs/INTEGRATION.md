# Integration guide

How to drive WrongForge from an orchestrator such as WrongStack: run it, submit
work, follow progress, survive failures. Field-by-field details are in
[TASKS-API.md](TASKS-API.md); this guide is the "how do I use it" companion.

- [Setup checklist](#setup-checklist)
- [The basic loop](#the-basic-loop)
- [Choosing how to follow a task](#choosing-how-to-follow-a-task)
- [Models and reasoning effort](#models-and-reasoning-effort)
- [Sessions: multi-step work](#sessions-multi-step-work)
- [Parallel work and workdirs](#parallel-work-and-workdirs)
- [Giving the agent more tools](#giving-the-agent-more-tools)
- [Anthropic-compatible endpoint](#anthropic-compatible-endpoint)
- [Teaching the agent your tooling (`prompts/`)](#teaching-the-agent-your-tooling-prompts)
- [Reliability patterns](#reliability-patterns)
- [Client examples](#client-examples)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)

## Setup checklist

1. **Sign in** on the machine that will run the agent: `npm run import` (reuses
   an existing Claude Code session) or `npm run login`. Or set
   `ANTHROPIC_API_KEY` to use a console API key instead (see the README's
   privacy section for the trade-offs). The sign-in self-heals: when the
   subscription refresh token dies, WrongForge adopts Claude Code's own
   session from `~/.claude/.credentials.json` automatically — the manual
   `npm run import` ritual is only needed when Claude Code's token is dead
   too (run Claude Code once, and the next WrongForge request recovers).
2. **Pick the safety settings** before the first task — the agent runs shell
   commands as the server's user:
   - `WRONGFORGE_ALLOWED_ROOTS` — directories tasks may start in
     (`;`-separated on Windows, `:` elsewhere);
   - `WRONGFORGE_WORKDIR` — a default workdir, so tasks need not name one;
   - keep `HOST=127.0.0.1` (default). Put TLS and a reverse proxy in front for
     anything else.
3. **Start it:** `npm run serve`. The banner shows the URL, the API key (the key
   is generated and saved on first start unless `AGENT_API_KEY` is set), the
   model, the data/log directories and the concurrency — plus the **live
   dashboard** URL (same origin, `/?key=<api key>`): traffic, tasks, model
   round-trips, tool calls and plan usage on one screen.
4. **Smoke test:**
   ```bash
   curl http://127.0.0.1:8787/health
   curl http://127.0.0.1:8787/v1/tasks -H "Authorization: Bearer $KEY" \
        -H "Content-Type: application/json" \
        -d '{"prompt":"say hello","workdir":"D:/work/app","wait":true}'
   ```
5. **Read `GET /v1/info`** from your client at startup: it tells you the default
   model, whether `workdir` is required, the allowed roots, limits and which
   tools and guides are active. Two newer fields worth knowing:
   - `model_details` — per model: `id`, `description`, and `effort_levels`
     (the reasoning-effort levels that model accepts; empty = none). Use it to
     offer only valid choices and to validate before submitting.
   - `workdir.suggestion` — a directory the server vouches for, handy for
     smoke tests when no default workdir is configured.

## The basic loop

```
POST /v1/tasks            → 202 { task }            (queued)
   … follow progress …    ← events (SSE / long-poll / webhook)
GET  /v1/tasks/:id        → task.status is terminal → read task.result / task.error
```

Changed your mind mid-run? `POST /v1/tasks/:id/cancel` stops a queued or
running task (reason optional); it ends in `cancelled` and its webhook fires.

Always read the **terminal status** and decide on it:

| Status | What to do |
|---|---|
| `completed` | `task.result.text` is the agent's final answer (it is asked to state what it did, which files changed, how it verified, and what is left). |
| `failed` | Look at `task.error.code`: `max_steps` / `max_tokens` → continue in the same session; `context_overflow` → re-send (the session compacts itself) or use a new session; `server_restarted` → re-send; `tool_gateway_unavailable` / `mcp_unavailable` → fix the dependency; `agent_error` → inspect `message`. A `max_steps`/`max_tokens` failure still carries a `result`. |
| `cancelled` | You (or a disconnect) cancelled it. |
| `timed_out` | `timeout_ms` elapsed. Raise it, or split the work. |

## Choosing how to follow a task

| You want | Use |
|---|---|
| The simplest thing: block until done | `POST /v1/tasks` with `"wait": true` (hold the connection; set a generous client timeout) |
| Live progress in a UI/terminal | `POST /v1/tasks` with `"stream": true`, or `GET /v1/tasks/:id/events` with `Accept: text/event-stream` (resumable with `Last-Event-ID`) |
| Firewall-friendly polling | `GET /v1/tasks/:id/events?after=<seq>&wait_ms=25000` in a loop |
| Push to your server, no open connection | `callback: { url }` (webhooks, HMAC-signed, retried) |
| One dashboard for everything | `GET /v1/events` (global SSE feed, filter by `task_id` / `session_id`) |

Tips:

- For long tasks prefer **submit → then follow separately** over `wait: true`:
  the task survives a dropped connection and you can reconnect with `after=`.
- Show the human-readable signals: `agent.report` (what the agent says it is
  doing, with optional `percent`/`phase`), `agent.todos` (its plan),
  `tool.started`/`tool.finished` (what it runs), and `task.heartbeat` (it is
  alive; `current_tool` shows what it is waiting on).
- `progress` in the task document is a cheap snapshot (`steps`, `tool_calls`,
  `current_tool`, `last_report`, `todos`) if you only need status.
- Use `cancel_on_disconnect: true` with `wait`/`stream` when the caller going
  away should also stop the work.
- The **global feed** replays its backlog on every connect: the last ≤300
  `http.request` frames (in-memory) AND the newest ≤300 task events read
  **from disk** — rounds, tool calls, texts, heartbeats skipped. The event
  replay survives serve restarts, so connecting late still shows what ran
  while you were away; frames carry original timestamps, so order by `ts`.
  Ignore `http.request` entirely if you only care about task events.

## Models and reasoning effort

Per task, `effort` sets how hard the model thinks: `"low" | "medium" |
"high" | "xhigh" | "max"` (server default `WRONGFORGE_EFFORT`, usually
`high`), or `"off"` to never send it. What each model accepts is in
`GET /v1/info` → `model_details[].effort_levels`; a level the model lacks is
**clamped to its nearest supported one** and models without effort support
never receive the field — so one setting works across the whole lineup and an
invalid choice can never fail a task. The level actually sent is visible per
model round-trip in the `step.request` event (`effort` in `data`). Effort is
purely a request-shaping knob on the WrongForge side; you pay for it through
output tokens, so prefer `low`/`medium` for high-volume mechanical jobs and
`high`+ for design or debugging work.

## Sessions: multi-step work

A session is the agent's memory. Reuse a `session_id` and a later task sees the
earlier conversation, including what files it touched:

```jsonc
// 1. analysis
{ "prompt": "Find why the login test fails", "session_id": "bug-142", "workdir": "D:/work/app" }
// 2. continue with context, no need to repeat anything
{ "prompt": "Fix it and run the tests again", "session_id": "bug-142", "workdir": "D:/work/app" }
```

- One session runs one task at a time; a second task for the same session waits
  in the queue (`task.queued.data.waiting_for = "session"`) and keeps its order.
- Sessions are durable (they survive restarts) and compact themselves when they
  get large — nothing to do on your side. Inspect with
  `GET /v1/sessions/:id/messages`; free the space with `DELETE`.
- Use a **new session per independent job** and one session per **conversation
  thread**: a huge mixed session costs more tokens and confuses the agent.
- If you change `workdir` inside a session, `task.started` carries
  `session_workdir_changed_from`; mention the change in your prompt if paths
  matter.
- Failed/cancelled tasks leave **no partial turn** in the session, so retrying
  with the same `session_id` is safe — except `max_steps`/`max_tokens`, where the
  progress is kept on purpose (send a "continue" task).

## Parallel work and workdirs

`WRONGFORGE_MAX_CONCURRENCY` (default 2) tasks run at once.

- Tasks in **different** directories are independent.
- Tasks in the **same** directory can trample each other's files. Set
  `workdir_lock: true` on the ones that write: they run one at a time per
  directory (and a waiting locked task holds back later tasks of that directory
  so it cannot starve). Read-only tasks can share a directory without a lock,
  but a locked task will wait for them and vice versa.
- A common pattern for parallel code changes: create a git worktree per task and
  give each its own `workdir`.
- The workdir is **where the agent starts, not a cage**: it can `cd` and write
  elsewhere. Restrict starting points with `WRONGFORGE_ALLOWED_ROOTS`; isolate
  for real with a container or VM.

## Giving the agent more tools

- **Your own tools** (call into WrongStack): the **tool gateway** —
  [TOOL-GATEWAY.md](TOOL-GATEWAY.md). Per task, discovered or inline,
  authenticated with a token that is never stored.
- **Third-party tools** (GitHub, databases, filesystems …): **MCP servers** —
  [MCP.md](MCP.md). Configured once on the server; select per task with `mcp`.
- **The WrongStack CLI itself:** the agent has `bash`, so it can run the CLI
  directly; describe how in a guide file (next section).

Gateway/MCP tool calls show up in the event log as `tool.*` events with
`external: true`; a `tools.loaded` event at task start lists what was loaded
(and any warnings).

## Anthropic-compatible endpoint

Besides the task API, the server mirrors the **Anthropic Messages API** itself:

- `POST /v1/messages` — streaming and non-streaming
- `POST /v1/messages/count_tokens`
- `GET /v1/models`, `GET /v1/models/:id`

Any Anthropic client — Claude Code, the official SDKs, another WrongForge,
your own code — can use the credentials the server holds instead of bringing
its own. Authentication is the server's API key (the same one as the task API),
sent as `x-api-key` (what the Anthropic SDKs send) or `Authorization: Bearer`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=<the WrongForge server key>
```

```js
// Node
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://127.0.0.1:8787", apiKey: WF_KEY });
```

```python
# Python
client = Anthropic(base_url="http://127.0.0.1:8787", api_key=WF_KEY)
```

With that, Claude Code (`claude`), SDK apps and prototypes all bill to the
server's account — no separate key distribution.

How requests travel upstream (same two modes as the agent itself, code:
`src/proxy.ts`):

| Server credential | Upstream behavior |
|---|---|
| OAuth (default) | Forwarded with the Claude Code client signature the agent uses — Bearer token, captured beta headers and the body fields the subscription requires. Streaming turns carry the CC `max_tokens` ceiling (128 000); 401s auto-refresh; the 400 self-heal applies. Client `output_config.effort` and `cache_control` markers are preserved. |
| `ANTHROPIC_API_KEY` set | Byte-for-byte passthrough — only the credential is swapped, the body is untouched. |

Notes:

- Responses pass through 1:1: status codes, SSE events, rate-limit and
  `anthropic-*` headers, error envelopes. The client's server key is never
  forwarded upstream.
- Proxy request bodies are capped at `WRONGFORGE_PROXY_MAX_BODY` (default
  32 MB) — larger than the task API's 1 MB, because Messages bodies carry long
  contexts and inline images.
- `WRONGFORGE_PROXY=0` turns the surface off entirely.
- Proxied traffic appears in the dashboard's traffic view (`http.request`
  frames) like any other call; plan usage is served by `GET /v1/usage`.
- The proxy shares the subscription's rate limits with the agent's own tasks —
  heavy parallel clients and task bursts draw from the same plan window.

## Teaching the agent your tooling (`prompts/`)

Every `*.md` file in the prompt directory (`<repo>/prompts`, or
`WRONGFORGE_PROMPT_DIR`) is appended to the system prompt as a section
`## Guide: <file name>`. Files starting with `_` and `README.md` are skipped;
files are read **for every task**, so edits apply without a restart. This is the
place for "how to drive the WrongStack CLI through bash", house rules, or
project conventions. (The directory is not created by default — create it and
drop files in. `GET /v1/info` → `tool_guides` shows which are active.)

Per task, `system_append` adds instructions on top (≤ 20 000 chars).

Keep guides **stable**: the system prompt is part of the cached prompt prefix.
Changing a guide (or `system_append`) makes the next request of every session
re-write its cache once. Put per-task facts in the `prompt`, not in the system
text. WrongForge already does this for the task id and workdir, which it places
at the start of the user message.

In task mode the agent is told that nobody can answer questions (it must make a
reasonable assumption or stop and explain a blocker), to avoid destructive
actions unless the task explicitly asks, to keep the orchestrator informed with
`report_progress`, and to end with a self-contained final message. Write your
prompts accordingly: say what "done" means and what may be changed.

## Reliability patterns

**Idempotent submit.** Generate your own `task_id` (e.g. `<job-id>-<attempt>`).
If a submit times out, re-send the same request: you get the existing task back
(`deduplicated: true`) instead of a duplicate. Same id with a different prompt
or session → `409 task_id_conflict`.

**Server restarts.** Running and queued tasks become `failed` /
`server_restarted` on the next start (their webhook fires). Re-send with the
**same `session_id`** (and a new `task_id`) to continue the conversation. Plan
for work that is not idempotent: the agent may have changed files before the
restart.

**Never lose events.** Remember the last `seq` you processed. After any
disconnect, resume with `?after=<seq>` (JSON) or `Last-Event-ID` (SSE). Events
are stored per task and are the source of truth; webhooks are best effort.

**Webhooks.** Verify the signature, answer `2xx` fast, de-duplicate by
`X-WrongForge-Delivery` or `(task_id, seq)`, and treat webhooks as a *hint*:
confirm the final state with `GET /v1/tasks/:id`. Gaps in `seq` mean you should
fetch the missing events from the API.

**Timeouts.** Set `timeout_ms` to what the job deserves (default 30 min, max
4 h) and `max_steps` as a runaway guard (default 50, max 500). Both end the task
with a clear status instead of hanging.

**Back-pressure.** The queue is unbounded; watch `queued`/`running` in
`/health` and `GET /v1/info`, and throttle submissions to your concurrency.

**Plan limits.** With a subscription login, `GET /v1/usage` shows the 5-hour and
weekly windows; use it to pause submissions near the limit.

## Client examples

### Node.js — submit, follow with SSE, resume on disconnect

```js
const BASE = "http://127.0.0.1:8787";
const KEY = process.env.WRONGFORGE_KEY;
const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function runTask(body, onEvent) {
  const sub = await fetch(`${BASE}/v1/tasks`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  if (!sub.ok) throw new Error(`submit failed: ${sub.status} ${await sub.text()}`);
  const { task } = await sub.json();

  let last = 0; // last seq processed
  for (;;) {
    try {
      const res = await fetch(`${BASE}/v1/tasks/${task.id}/events?after=${last}`, {
        headers: { ...auth, Accept: "text/event-stream" },
      });
      if (!res.ok) throw new Error(`events: ${res.status}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!type || !data || type === "end") continue;
          const ev = JSON.parse(data);
          if (ev.seq > last) { last = ev.seq; onEvent(ev); }
        }
      }
      break;                                   // stream ended = task is terminal
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000)); // reconnect, resume from `last`
    }
  }
  return (await (await fetch(`${BASE}/v1/tasks/${task.id}`, { headers: auth })).json()).task;
}

const done = await runTask(
  { prompt: "run the tests and summarize failures", workdir: "D:/work/app", session_id: "ci-1" },
  (ev) => {
    if (ev.type === "agent.report") console.log("•", ev.data.message);
    if (ev.type === "tool.started")  console.log("▸", ev.data.name);
    if (ev.type === "agent.text")    process.stdout.write(ev.data.text);
  },
);
console.log("\n", done.status, done.result?.text ?? done.error);
```

### Python — long-poll (no streaming needed)

```python
import os, time, requests

BASE = "http://127.0.0.1:8787"
H = {"Authorization": f"Bearer {os.environ['WRONGFORGE_KEY']}"}

task = requests.post(f"{BASE}/v1/tasks", headers=H, json={
    "task_id": "nightly-lint-2026-10-15",          # idempotent: safe to retry
    "prompt": "run the linter and fix what is safe to fix",
    "workdir": "D:/work/app", "workdir_lock": True, "max_steps": 80,
}).json()["task"]

after = 0
while True:
    r = requests.get(f"{BASE}/v1/tasks/{task['id']}/events",
                     headers=H, params={"after": after, "wait_ms": 25000}, timeout=40).json()
    for ev in r["events"]:
        if ev["type"] == "agent.report":
            print("•", ev["data"]["message"])
    after = r["next_after"]
    if r["terminal"] and not r["events"]:
        break

final = requests.get(f"{BASE}/v1/tasks/{task['id']}", headers=H).json()["task"]
print(final["status"], (final.get("result") or {}).get("text") or final.get("error"))
```

### Webhook receiver (Node, Express-style)

```js
import crypto from "node:crypto";
import express from "express";

const KEY = process.env.WRONGFORGE_WEBHOOK_SECRET ?? process.env.WRONGFORGE_KEY;
const seen = new Set();

express().post("/wf", express.raw({ type: "*/*" }), (req, res) => {
  const ts = req.header("x-wrongforge-timestamp");
  const want = "sha256=" + crypto.createHmac("sha256", KEY).update(`${ts}.${req.body}`).digest("hex");
  const got = req.header("x-wrongforge-signature") ?? "";
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(401);
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.sendStatus(400);

  const id = req.header("x-wrongforge-delivery");
  if (seen.has(id)) return res.sendStatus(200);          // retry of something we already handled
  seen.add(id);

  const ev = JSON.parse(req.body);
  if (ev.type === "task.completed") console.log(ev.task_id, ev.data.result.text);
  if (ev.type === "task.failed")    console.log(ev.task_id, ev.data.error);
  res.sendStatus(200);
}).listen(9000);
```

Submit with `"callback": { "url": "http://127.0.0.1:9000/wf", "events": ["task.*", "agent.report"] }`.

## Operations

**What runs where.** One Node process (`npm run serve`) with in-process queue,
webhook dispatcher and MCP pool. State is on disk under the data directory
(`~/.wrongforge`, or `WRONGFORGE_HOME`):

| Path | Contents |
|---|---|
| `tasks/<id>/` | `task.json`, `events.jsonl` (gzip after 3 days, deleted after 90) |
| `sessions/<id>/` | `session.json`, `messages.jsonl`, compaction archives |
| `logs/` | daily JSONL logs, rolled over at `WRONGFORGE_LOG_MAX_MB` (50), gzip after 1 day, deleted after 30; secrets masked |
| `mcp.json`, `api-key`, token store | configuration and secrets (0600 / encrypted) |
| `effort-rejections.json` | models the API refused the `effort` field for (learned automatically, expires after 7 days) |

**Logs.** One JSON object per line. `WRONGFORGE_LOG_LEVEL=debug` for more,
`WRONGFORGE_LOG_STDERR=1` to mirror to the console. Every task event is logged
with `task_id`, `session_id` and `seq`.

**Housekeeping** runs at start and hourly (`WRONGFORGE_MAINTENANCE_INTERVAL_MIN`);
`POST /v1/maintenance/run` runs it now. Retention knobs are in the README's
configuration table. Live tasks and busy sessions are never touched.

**Stopping.** Ctrl+C / SIGTERM: no new tasks, running ones are interrupted and
marked `server_restarted`, webhooks are flushed (≤ 10 s), MCP connections
closed. The process exits after at most 20 s.

**Upgrading.** The task/event protocol version is `protocol: 1` in
`GET /v1/info`. Tolerate unknown event types and unknown fields on your side;
new ones may be added.

**Security reminders.** Whoever holds the API key can run commands as the
server's user. Keep it on loopback, keep the key out of logs and client-side
code, restrict `WRONGFORGE_ALLOWED_ROOTS`, and use a container or VM when
prompts are not fully trusted. There is no per-command approval.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 unauthorized` | Missing/incorrect `Authorization: Bearer <key>`. The key is in the startup banner / `<data dir>/api-key` / `AGENT_API_KEY` |
| `503 not_signed_in` | Run `npm run import` or `npm run login` on the server's machine (check `GET /health` → `signed_in`) |
| Tasks fail with "token refresh failed" | WrongForge already tries to adopt Claude Code's session automatically; if that failed too, run Claude Code once (e.g. `claude -p OK`) so its token refreshes — the next WrongForge request recovers on its own. Manual: `npm run import` |
| `400 workdir_required` | The server has no default workdir: pass `workdir`, or set `WRONGFORGE_WORKDIR` |
| `403 workdir_not_allowed` | The directory is outside `WRONGFORGE_ALLOWED_ROOTS` (symlinks are resolved first) |
| `400 invalid_gateway` … "host is not allowed" | Gateway URL is not loopback: add the host to `WRONGFORGE_GATEWAY_ALLOWED_HOSTS` |
| `400 unknown_mcp_server` | The `mcp` list names a server that is not configured (`GET /v1/mcp/servers`) |
| Task sits in `queued` | Read `task.queued.data.waiting_for`: `capacity` (raise `WRONGFORGE_MAX_CONCURRENCY`), `session` (another task of the session runs), `workdir` (a lock) |
| `failed` / `max_steps` | Step budget too small for the job; send a follow-up in the same session, or raise `max_steps` |
| `failed` / `context_overflow` | Session too big for the model; re-send (it compacts first) or start a new session |
| `failed` / `server_restarted` | The server stopped mid-task; re-send, same `session_id` |
| `failed` / `agent_error` with a 429 or a "third-party apps" message | Plan/limit or access problem on the Anthropic side — see `GET /v1/usage`, and the README's privacy/fragility note; an API key (`ANTHROPIC_API_KEY`) avoids the subscription path |
| Webhook never arrives | Check `task.callback_stats` (`failed`, `last_error`) and the logs (`webhook.retry`/`webhook.failed`); non-retryable 4xx responses are dropped — fetch the events from the API |
| SSE stream stalls behind a proxy | Disable response buffering (`X-Accel-Buffering: no` is already sent); pings arrive every 15 s |
