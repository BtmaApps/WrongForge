# HTTP API

WrongForge can run as a local HTTP service: you send a prompt, the agent
works on it (reading files, running commands, editing code …) and **every text
delta, tool call and tool result is streamed back to you live** as it happens.

Implementation: [`src/server.ts`](../src/server.ts) (plain `node:http`, no extra
dependencies). The agent loop is the same one the REPL uses
([`src/agent.ts`](../src/agent.ts)), driven through the `onEvent` callback.

## Start

```bash
npm run import                      # once: reuse your Claude Code session (or `npm run login`)

# PowerShell
$env:AGENT_API_KEY = "a-long-random-secret-at-least-16-chars"; npm run serve
# bash
AGENT_API_KEY=a-long-random-secret-at-least-16-chars npm run serve
```

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_API_KEY` | – (**required**, ≥ 16 chars) | Bearer key clients must send. The server refuses to start without it |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address. Keep loopback unless you put TLS + a proxy in front |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Default model |
| `CLAUDE_TOKEN_STORE` | `~/.wrongforge/tokens.json` | Token file |

## Security — read this first

The agent has a `bash` tool and `write`/`edit` tools: **whoever holds the API
key can run arbitrary commands as the user that started the server, in the
server's working directory.** Therefore:

- The key is mandatory, compared in constant time; `/health` is the only
  unauthenticated route.
- It binds to `127.0.0.1` by default. Do not expose it to a network without TLS
  and a reverse proxy; never put the key in client-side/browser code.
- There is no sandbox and no per-command approval over the API (the system
  prompt only *asks* the model to be careful about destructive actions). Run the
  server in a throw-away directory / container / VM if the prompts are not
  fully trusted.
- Request bodies are capped at 1 MB; max 100 in-memory sessions (least recently
  used idle session is evicted); `max_steps` is clamped to 1–100.

## Authentication

```
Authorization: Bearer <AGENT_API_KEY>
```

Missing/wrong key → `401 {"error":"unauthorized"}`.

## Endpoints

### `POST /v1/run`

Run the agent on a prompt.

Request body (JSON):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | **required** | The instruction |
| `session_id` | string | new UUID | Conversation to continue. The history is kept in memory, so later calls with the same id remember earlier ones |
| `model` | string | `CLAUDE_MODEL` / `claude-sonnet-5-5` | Model ID for this run |
| `max_steps` | integer | `20` | Max LLM steps (tool round-trips), 1–100 |
| `stream` | boolean | `true` | `true` → Server-Sent Events; `false` → one JSON response |

Only one run per session at a time; a second one gets `409`.
If the client disconnects mid-run, the run is aborted and that turn is
discarded from the session history (a failed/aborted turn never pollutes it).

#### Streaming response (`stream: true`, default)

`Content-Type: text/event-stream`. Each event is
`id: <n>`, `event: <name>`, `data: <json>`.

| Event | `data` | When |
|---|---|---|
| `start` | `{ session_id, model }` | First event — **save the `session_id`** |
| `text` | `{ type, delta }` | Model text, incrementally |
| `tool_call` | `{ type, id, name, input }` | The model decided to call a tool (before it runs) |
| `tool_result` | `{ type, id, name, output }` | The tool finished; `id` matches the `tool_call` |
| `tool_error` | `{ type, id, name, error }` | The tool threw |
| `error` | `{ type, error }` | The run failed (stream ends) |
| `done` | `{ session_id, model, finish_reason, tool_calls, text }` | Final event; `text` is the full assistant text |

`finish_reason` is the AI SDK's: `stop`, `length`, `tool-calls` (hit
`max_steps`), `aborted`, …

Example stream:

```
event: start
data: {"session_id":"s1","model":"claude-sonnet-5-5"}

event: tool_call
data: {"type":"tool_call","id":"toolu_01","name":"ls","input":{"path":"."}}

event: tool_result
data: {"type":"tool_result","id":"toolu_01","name":"ls","output":{"ok":true,"entries":[...]}}

event: text
data: {"type":"text","delta":"The directory contains …"}

event: done
data: {"session_id":"s1","model":"claude-sonnet-5-5","finish_reason":"stop","tool_calls":1,"text":"The directory contains …"}
```

`tool_result.output` is exactly what the tool returned to the model (e.g. for
`bash`: `{ ok, exitCode, stdout, stderr, durationMs, … }`) — not truncated by
the API.

#### JSON response (`stream: false`)

```json
{
  "session_id": "s1",
  "model": "claude-sonnet-5-5",
  "finish_reason": "stop",
  "tool_calls": 1,
  "text": "final answer",
  "events": [ { "type": "tool_call", "...": "..." }, { "type": "tool_result", "...": "..." }, { "type": "text", "delta": "..." } ]
}
```

`events` holds the same events as the stream, in order (all returned at the
end — use SSE if you want them live).

### `GET /v1/tools`

`{ "tools": [ { "name": "bash", "description": "…" }, … ] }`

### `GET /v1/sessions`

`{ "sessions": [ { "id", "messages", "busy", "updated_at" } ] }`

### `DELETE /v1/sessions/:id`

Drops a session's history. `200 {"deleted":id}`, `404` unknown, `409` busy.

### `GET /health`

No auth. `{ "ok": true, "signedIn": true|false }`.

## Status codes

| Code | Meaning |
|---|---|
| 200 | OK (SSE streams also start with 200; failures after that arrive as an `error` event) |
| 400 | Invalid JSON / missing `prompt` |
| 401 | Missing or wrong API key |
| 404 | Unknown route / session |
| 409 | Session already running a prompt |
| 499 | (`stream:false`) client aborted |
| 500 | (`stream:false`) run failed |
| 503 | Agent not signed in (`npm run import` / `npm run login`) |

## Client examples

### curl

```bash
# live stream (-N disables curl's buffering)
curl -N http://127.0.0.1:8787/v1/run \
  -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"list the dependencies in package.json","session_id":"demo"}'

# single JSON answer
curl http://127.0.0.1:8787/v1/run \
  -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"now summarize them","session_id":"demo","stream":false}'
```

### Node.js (18+, no dependencies)

```js
const res = await fetch("http://127.0.0.1:8787/v1/run", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.AGENT_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "run the tests and tell me what fails", session_id: "demo" }),
});
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
    if (event === "tool_call")        console.log("▸", data.name, JSON.stringify(data.input));
    else if (event === "tool_result") console.log("  ↳", JSON.stringify(data.output).slice(0, 200));
    else if (event === "text")        process.stdout.write(data.delta);
    else if (event === "done")        console.log("\n[done]", data.finish_reason);
    else if (event === "error")       console.error("error:", data.error);
  }
}
```

### Python (`requests`)

```python
import json, os, requests

r = requests.post(
    "http://127.0.0.1:8787/v1/run",
    headers={"Authorization": f"Bearer {os.environ['AGENT_API_KEY']}"},
    json={"prompt": "list the files here", "session_id": "demo"},
    stream=True,
)
r.raise_for_status()

event = None
for line in r.iter_lines(decode_unicode=True):
    if line.startswith("event: "):
        event = line[7:]
    elif line.startswith("data: "):
        data = json.loads(line[6:])
        if event == "tool_call":
            print("▸", data["name"], data["input"])
        elif event == "tool_result":
            print("  ↳", str(data["output"])[:200])
        elif event == "text":
            print(data["delta"], end="", flush=True)
        elif event == "done":
            print("\n[done]", data["finish_reason"])
```

### Cancelling a run

Close the HTTP connection (curl: Ctrl+C; fetch: `AbortController`). The server
aborts the model call and any running `bash` process tree, and discards the turn.

## Limitations

- Sessions live in memory only — restarting the server forgets them.
- The working directory (and therefore the file/shell scope) is the directory
  the server was started in; there is no per-request `cwd`.
- No per-tool approval/permission prompts over the API (see *Security*).
- One run per session at a time; different sessions run in parallel but share
  the same machine, filesystem and todo list state.

## Tests

```bash
npx tsx test/server.test.ts   # offline: auth, SSE tool-call stream, JSON mode, sessions, validation
```

It starts the real API server against a fake Anthropic SSE server, so the
`ls` tool call really executes and its `tool_call`/`tool_result` events are
asserted in order.

### `GET /v1/usage`

Plan-usage state of the signed-in subscription (same source as Claude Code's
`/usage`). Cached server-side for 5 minutes; `?force=1` bypasses the cache.

```json
{
  "five_hour":   { "percent": 41, "resetsAt": "2026-10-15T17:29:59Z", "isActive": true },
  "weekly":      { "percent": 0,  "resetsAt": "2026-10-16T17:00:00Z", "isActive": false },
  "extra_usage": { "enabled": false, "usedCredits": null, "monthlyLimit": null, "utilization": null }
}
```

Errors: `502 usage_unavailable` when the backend cannot be read.
