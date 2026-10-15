# Tool gateway

The gateway lets the orchestrator (WrongStack) lend tools to the agent over
HTTP. WrongForge shows them to the model as if they were native tools; when the
model calls one, WrongForge `POST`s the call back to the orchestrator and hands
the answer to the model.

Implementation: `src/tools/gateway.ts`. Request validation: `validateGatewaySpec`.
Part of the task protocol — see [TASKS-API.md](TASKS-API.md).

```
model ──tool_use──▶ WrongForge ──POST {url}/tools/<name>/call──▶ orchestrator
model ◀─tool_result─ WrongForge ◀────────── { ok, output | error } ──────┘
```

## Enabling it for a task

Add a `gateway` object to `POST /v1/tasks`. Two ways to provide the tool list:

**Discovery** — WrongForge asks the orchestrator at task start:

```json
{
  "prompt": "…", "workdir": "D:/work/app",
  "gateway": { "url": "http://127.0.0.1:7777", "token": "s3cret" }
}
```

**Inline** — the definitions are in the request, no discovery call:

```json
{
  "gateway": {
    "url": "http://127.0.0.1:7777",
    "tools": [
      { "name": "create_ticket",
        "description": "Create a ticket in the tracker",
        "input_schema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] } }
    ]
  }
}
```

### `gateway` fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | **required** | Base URL of the orchestrator's tool API. http(s). |
| `token` | string | – | Sent as `Authorization: Bearer <token>`. ≤ 4096 chars. **Memory only.** |
| `headers` | object of strings | – | Extra request headers (≤ 20; names `[A-Za-z0-9-]{1,64}`, values ≤ 4096). **Memory only.** If `token` is set, `Authorization` is overwritten by it. |
| `list_path` | string | `/tools` | Discovery path (must start with `/`). |
| `call_path` | string | `/tools/{name}/call` | Call path; `{name}` is replaced by the URL-encoded tool name. |
| `tools` | array | – | Inline definitions (≤ 200). When present, no discovery request is made. |
| `allow` | string[] | – | Only expose tools whose name matches (exact, or a `*` suffix wildcard). ≤ 100. |
| `deny` | string[] | – | Never expose matching tools. |
| `name_prefix` | string | `wstack_` | Prefix of the names the model sees. `[A-Za-z0-9_]{0,20}`. |
| `call_timeout_ms` | integer | `120000` | Per-call timeout, 1000–600000. |
| `optional` | boolean | `false` | `true`: if discovery fails, run the task **without** these tools instead of failing it. |

### Which hosts are allowed

By default `url` must point to **loopback** (`127.0.0.1`, `localhost`, `::1`).
Anything else is rejected with `400 invalid_gateway` unless the operator lists
it in `WRONGFORGE_GATEWAY_ALLOWED_HOSTS` (comma-separated host names, or `*` for
any). The check is on the host name only (not the port).

## The orchestrator's side of the contract

### Discovery: `GET {url}{list_path}`

Headers: `Accept: application/json`, plus `Authorization` / your `headers`.
Timeout 10 s. Answer `200` with either

```json
{ "tools": [ { "name": "create_ticket", "description": "…", "input_schema": { "type": "object", "properties": {} } } ] }
```

or a bare JSON array of the same objects. The schema may also be named
`inputSchema` or `parameters`. Rules applied to each definition:

- `name` is required; entries without one are skipped with a warning.
- The schema's top-level `type` must be `"object"` (it is filled in when
  missing; `properties` defaults to `{}`); other schemas are skipped.
- `description` defaults to a generic text and is cut to 4000 chars.
- Tools are filtered by `allow` / `deny` (matched against the **remote** name).
- At most 200 tools are exposed; the rest is dropped with a warning.

Discovery answers are cached in memory for 30 s per (url, list_path,
credentials) — `WRONGFORGE_GATEWAY_DISCOVERY_TTL_MS` (0 disables).

### Calls: `POST {url}{call_path}`

Headers: `Content-Type: application/json`, `Accept: application/json`,
`X-WrongForge-Task`, `X-WrongForge-Session`, `X-WrongForge-Tool-Call` (the
model's tool-call id), plus `Authorization` / your `headers`. Body:

```json
{
  "tool": "create_ticket",
  "input": { "title": "Fix login" },
  "task_id": "tsk_…",
  "session_id": "ses_…",
  "call_id": "toolu_…",
  "workdir": "D:\\work\\app"
}
```

`tool` is the **remote** name (without the prefix). Answer with `200` and:

- `{ "ok": true, "output": … }` — success; or
- `{ "ok": false, "error": "what went wrong" }` — a tool-level failure the model
  can react to; or
- **any other JSON / plain text** — treated as the output (`{ ok: true, output: <body> }`).

A non-2xx status becomes `{ ok: false, error: "tool gateway answered HTTP <status>: <body, shortened>" }`.
Calls abort when the task is cancelled, times out or the call exceeds
`call_timeout_ms`. Answers over 60 000 chars are shortened (beginning and end
are kept) and flagged `truncated: true`.

**Calls never fail the task.** Timeouts, unreachable servers and error answers
reach the model as `{ ok: false, error }`, exactly like with a built-in tool, so
it can retry or change approach.

## What the model sees

- Names are `<name_prefix><remote name>` with every character outside
  `[A-Za-z0-9_-]` replaced by `_`, at most 64 chars: `create_ticket` →
  `wstack_create_ticket`.
- Names that would collide with a built-in tool (`bash`, `read`, …) or with
  each other are skipped with a warning — pick another `name_prefix`.
- The list is **sorted by name**, so it is byte-identical between tasks as long
  as the orchestrator's tool set does not change. Tool definitions are part of
  the prompt-cache prefix; a stable list keeps session caches warm. Changing a
  tool's name, description or schema restarts the cache once.

## Events

After loading, the task log gets a `tools.loaded` event:

```json
{ "type": "tools.loaded", "data": {
    "source": "discovery", "url": "http://127.0.0.1:7777", "count": 4,
    "tools": ["wstack_create_ticket", "…"], "hash": "9f2c1ab04d7e5513",
    "cached": false, "warnings": [] } }
```

`hash` fingerprints the exposed set (names, descriptions, schemas) — if it
changes between tasks of a session, expect a cache rewrite. `warnings` lists
skipped tools. With `optional: true` and a failed discovery you get `count: 0`
and an `error` field instead.

Each call shows up as `tool.started` / `tool.finished` / `tool.failed` with
`external: true`. The task document stores a secret-free `gateway` view
(`url`, paths, prefix, timeout, `optional`, `inline`, `allow`/`deny`,
`has_token`, `header_names`, `tool_names`) — the token and header values are
never persisted or logged.

## Failure handling

| Situation | Result |
|---|---|
| Discovery fails (timeout, HTTP error, not JSON, wrong shape), `optional: false` | task `failed`, `error.code = tool_gateway_unavailable` |
| Same, `optional: true` | task runs without gateway tools; `tools.loaded` has `count: 0` + `error` |
| Invalid `gateway` object | `400 invalid_gateway` at submit |
| A call fails / times out | `{ ok: false, error }` to the model; task continues |
| Task cancelled during a call | the HTTP call is aborted |

## Minimal orchestrator example (Node)

```js
import http from "node:http";

const TOOLS = [{
  name: "echo", description: "Echo the text back",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}];

http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer s3cret") { res.writeHead(401).end(); return; }
  if (req.method === "GET" && req.url === "/tools") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ tools: TOOLS }));
  }
  const m = /^\/tools\/([^/]+)\/call$/.exec(req.url ?? "");
  if (req.method === "POST" && m) {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { input, task_id } = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, output: `task ${task_id} says: ${input.text}` }));
    });
    return;
  }
  res.writeHead(404).end();
}).listen(7777, "127.0.0.1");
```

Submit a task with `"gateway": { "url": "http://127.0.0.1:7777", "token": "s3cret" }`
and the agent can call `wstack_echo`.
