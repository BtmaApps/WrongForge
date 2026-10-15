# MCP servers

WrongForge is an [MCP](https://modelcontextprotocol.io) **client**. You
configure MCP servers once; their tools then become available to the agent.
Code: `src/mcp/config.ts` (config file), `src/mcp/registry.ts` (connections),
`src/tools/mcp-tools.ts` (agent tools), `src/mcp-cli.ts` (terminal).

- [Quick start](#quick-start)
- [Config file](#config-file) · [Server options](#server-options) · [Secrets](#secrets)
- [How the agent uses MCP](#how-the-agent-uses-mcp)
- [Choosing servers per task](#choosing-servers-per-task)
- [Terminal](#terminal-commands) · [HTTP management](#http-management)
- [Connections & lifecycle](#connections--lifecycle) · [Tool results](#tool-results)
- [Failure handling](#failure-handling) · [Security](#security)

## Quick start

```bash
# a remote server (Streamable HTTP is the default type)
npm run mcp -- add github --url https://api.githubcopilot.com/mcp/ \
    --header "Authorization=Bearer \${GITHUB_TOKEN}"

# a local server started as a child process (arguments go after "--")
npm run mcp -- add fs --command npx -- -y @modelcontextprotocol/server-filesystem D:/work

npm run mcp -- test github        # connects and lists the tools
npm run mcp -- list
```

Changes are written to the config file and picked up by a **running server on
its next use** — no restart. From the next task on, the server's tools appear
to the agent as `mcp_<server>_<tool>`.

## Config file

`$WRONGFORGE_MCP_CONFIG`, else `<data dir>/mcp.json` (`~/.wrongforge/mcp.json`;
written with mode 0600, atomically). `npm run mcp -- path` prints the location.
The format is Claude Code's `mcpServers` format, so existing configs can be
pasted in:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "description": "GitHub issues and PRs",
      "deny": ["delete_*"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"],
      "eager": false
    }
  }
}
```

The `type` is inferred when missing: `command` → `stdio`, `url` → `http`. One
bad entry never breaks the others — invalid entries are reported
(`invalid_entries` / `errors`) and ignored; a file that is not valid JSON is
reported as an error.

Server names: letters, digits, `_` and `-`, 1–32 chars, starting with a letter
or digit.

## Server options

| Key | Applies to | Default | Meaning |
|---|---|---|---|
| `type` | all | inferred | `http` (Streamable HTTP), `sse`, or `stdio` |
| `url` | http, sse | – | http(s) URL (may contain `${VAR}`) |
| `headers` | http, sse | – | Request headers (≤ 30); values may use `${VAR}` |
| `command` | stdio | – | Program to start |
| `args` | stdio | – | Arguments (≤ 100 strings) |
| `env` | stdio | – | Environment for the child process (≤ 100); values may use `${VAR}` |
| `cwd` | stdio | – | Working directory of the child process |
| `enabled` | all | `true` | `false` keeps the entry but never connects |
| `eager` | all | `true` | `true`: tools are exposed one by one, with schemas, at task start. `false`: reachable only via `mcp_tools` / `mcp_call` |
| `required` | all | `false` | `true`: a task that selects this server **fails** (`mcp_unavailable`) if it cannot connect; otherwise it is skipped with a warning |
| `description` | all | – | Free text for humans and the agent (≤ 500 chars) |
| `allow` | all | – | Only these tool names (exact, or `*` suffix wildcard) |
| `deny` | all | – | Never these tool names |
| `timeout_ms` | all | `120000` | Per tool call, 1000–3 600 000 |
| `startup_timeout_ms` | all | `30000` | Connect + initialize, 1000–3 600 000 |
| `legacy_init` | all | – | Accepted and stored, but **currently has no effect** |

`url`/`headers` are rejected on stdio entries and `command`/`args`/`env` on
http/sse entries. Unknown keys are dropped on save.

`allow` / `deny` hold for **every** way a tool can be called (typed tools,
`mcp_call`, the HTTP API, the CLI), not just for exposure.

## Secrets

Put secrets in environment variables and reference them as `${NAME}` or
`${NAME:-default}` in `url`, `headers`, `command`, `args`, `cwd` and `env`
values. They are expanded **when a connection is opened**, from the server
process's environment, so the config file itself holds no token. A missing
variable without a default fails the connection with a clear message
(`environment variable X is not set`).

Everything shown to the model, returned by the API, or logged goes through
redaction: header and env values are replaced by `[redacted]` unless they are a
`${…}` reference, and a URL's credentials/query string are masked.

## How the agent uses MCP

Two modes, which can be mixed:

**Eager (typed tools).** At task start WrongForge connects to the selected
servers, lists their tools and gives the model one tool per MCP tool, named
`mcp_<server>_<tool>` (characters outside `[A-Za-z0-9_-]` become `_`; names over
64 chars are shortened with a hash). Descriptions are prefixed `[MCP <server>]`.
Best accuracy — the model has the full JSON schema — but the definitions cost
prompt tokens. The list is sorted by name so it is stable between tasks (it is
part of the prompt-cache prefix). Limits: at most 128 typed tools per task (the
rest is dropped with a warning — narrow it with `allow`/`deny` or the task's
`mcp` list); names colliding with built-in tools or each other are skipped.

**Lazy (agent tools).** Five built-in tools let the agent work with *any*
configured server, even one added in the middle of a task:

| Tool | Purpose |
|---|---|
| `mcp_servers` | List configured servers: transport, enabled/eager, connected, cached tool count, last error, redacted spec |
| `mcp_tools` | `server` → tool names with short descriptions; `server` + `tool` → that tool's full description and input schema (`refresh: true` bypasses the cache) |
| `mcp_call` | `server`, `tool`, `input` → `{ ok, output }` or `{ ok: false, error }` |
| `mcp_add` | Add/replace a server (http, sse or stdio) and test it (`test: false` skips the test) |
| `mcp_remove` | Delete a server |

Typical lazy flow: `mcp_servers` → `mcp_tools` → `mcp_tools` with `tool` →
`mcp_call`. After `mcp_add`, the new server is usable immediately this way; its
typed tools appear from the next task on.

Set `WRONGFORGE_MCP_AGENT_MANAGE=0` to make the agent read-only with respect to
MCP: it can still list and call, but `mcp_add` / `mcp_remove` return an error.

## Choosing servers per task

`POST /v1/tasks` takes an optional `mcp` array:

| Value | Typed tools come from |
|---|---|
| omitted | every server that is **enabled and `eager`** |
| `["*"]` | every **enabled** server (lazy ones too) |
| `["github","db"]` | exactly these servers (a disabled one is skipped with a warning) |
| `[]` | none — the agent can still use `mcp_tools` / `mcp_call` |

Unknown names are rejected at submit with `400 unknown_mcp_server`. The task
document records the selection in `mcp`. After loading, a `tools.loaded` event
with `source: "mcp"` reports `servers` (`{ name, ok, tools, error? }`), `count`,
`tools`, `hash` and `warnings`.

A selected server that cannot be reached is **skipped with a warning** — unless
it is `required: true`, in which case the task fails with `mcp_unavailable`
before the model is called.

## Terminal commands

Run as `npm run mcp -- <command>`:

| Command | Effect |
|---|---|
| `list` | Show configured servers (`[transport; enabled\|disabled, eager\|lazy, required]`) and invalid entries |
| `add <name> --url <url> [--type http\|sse] [--header "Name=Value"]…` | Add a remote server |
| `add <name> --command <cmd> [--env "NAME=value"]… [--cwd <dir>] -- <args…>` | Add a local stdio server |
| `add-json <name> '<json>'` | Add from a JSON entry |
| `import <file> [--overwrite]` | Import a Claude Code / Claude Desktop style `{ "mcpServers": {…} }` (or the bare map). Existing names are skipped unless `--overwrite` |
| `remove <name>` | Delete |
| `enable <name>` / `disable <name>` | Toggle `enabled` |
| `test <name>` | Connect, print server info, tools and any server instructions |
| `tools <name> [tool]` | List tools, or print one tool's schema |
| `call <name> <tool> '<json>'` | Call a tool once |
| `path` | Print the config file location |

Shared options for `add` / `add-json` / `import`: `--description`,
`--eager true|false`, `--required true|false`, `--allow a,b*`, `--deny c,d*`,
`--timeout <ms>`. Global: `--json` for machine-readable output. Exit codes: `0`
ok, `1` error or failed test/call, `2` unknown command.

On a shell that expands `$`, escape secrets references: `"Authorization=Bearer \${TOKEN}"`.

## HTTP management

All under `Authorization: Bearer <key>`, see [TASKS-API.md](TASKS-API.md#http-errors) for error shapes.

| Endpoint | Meaning |
|---|---|
| `GET /v1/mcp/servers` | `{ servers: [{ name, spec (redacted), connected, tools_cached?, last_error?, server_info? }], errors, file }` |
| `PUT /v1/mcp/servers/:name` | Add/replace; body = the server entry. `?test=1` also connects and returns `test`. `201` new, `200` replaced; `400 invalid_mcp_config` |
| `DELETE /v1/mcp/servers/:name` | `{ removed }`; `404 mcp_server_not_found` |
| `POST /v1/mcp/servers/:name/test` | `{ ok, error?, server_info?, instructions?, tools: [{name, description}], duration_ms }` |
| `GET /v1/mcp/servers/:name/tools` | `{ server, tools: [{ name, description, schema }] }`; `?tool=<name>` for one; `?refresh=1` bypasses the cache |
| `POST /v1/mcp/servers/:name/enable` · `…/disable` | Toggle; returns the server status |
| `POST /v1/mcp/import` | Body = a Claude Code style document, plus optional `"overwrite": true` → `{ added, updated, skipped, invalid }` |

Status codes beyond the usual: `404 unknown_server`, `409 server_disabled`,
`502` for connection failures (`mcp_unavailable`, `mcp_error`).

## Connections & lifecycle

- **Pooled.** A connection is opened on first use and reused by later tasks;
  it is closed after `WRONGFORGE_MCP_IDLE_MS` without use (default 5 min) —
  `npx`-started stdio servers are slow to boot and must not restart for every
  task. Concurrent users of one server share one connection.
- **Tool lists are cached** for `WRONGFORGE_MCP_TOOLS_TTL_MS` (default 60 s;
  0 = always ask). Pagination is followed (up to 20 pages).
- **Config changes** close the server's pooled connection; the next use
  reconnects with the new settings. A connection is keyed by the server's whole
  entry, so editing the file by hand has the same effect.
- **Dead connections** (closed pipe, `ECONNRESET`, …) are dropped from the pool
  and reopened on the next call.
- **stdio stderr** goes to `<config dir>/mcp-logs/<server>.stderr.log`
  (overwritten on every connect); its tail is appended to connection errors.
- On server shutdown all connections are closed.

## Tool results

An MCP `CallToolResult` becomes `{ ok, output }` for the model:

- `text` blocks are joined with newlines;
- images and audio become a short note (`[image image/png, 1234 bytes — not shown]`);
- embedded resources: their text, or a note for binary ones; resource links
  become `[resource link <uri>]`;
- if there is no text but `structuredContent`, that JSON is used; with both,
  the structured data is also returned as `structured`;
- `isError: true` → `{ ok: false, error: <text> }`;
- output over 60 000 chars keeps its beginning and end and gets `truncated: true`.

## Failure handling

| Situation | Result |
|---|---|
| Call fails, times out or the server is gone | `{ ok: false, error }` to the model; the task continues. Timeouts say `the call timed out after N ms` |
| Task cancelled during a call | the call is aborted: `the call was cancelled` |
| Tool not permitted by `allow`/`deny` | `{ ok: false, error: "…not permitted by the allow/deny list…" }` |
| Server unknown / disabled | `{ ok: false, error }` (HTTP: `404 unknown_server` / `409 server_disabled`) |
| Selected server unreachable at task start | skipped + warning; `required: true` → task `failed` (`mcp_unavailable`) |
| Config file broken | the task runs **without** eager MCP tools; a warning appears in `tools.loaded` and the log — one bad file never takes every task down |

## Security

- MCP servers run with real power: a **stdio** server is a program started on
  this machine with the server's rights, and any server's tools can read data,
  write data or call external services. Add only servers you trust.
- The agent can add servers itself (`mcp_add`) — including stdio ones, i.e.
  arbitrary commands. That is no more power than its `bash` tool already has,
  but if you do not want the agent changing the config, set
  `WRONGFORGE_MCP_AGENT_MANAGE=0`. Over the HTTP API, `PUT /v1/mcp/servers/:name`
  is likewise equivalent to shell access for the key holder.
- Use `allow` / `deny` to hide dangerous tools, and `${VAR}` references so the
  config file holds no secrets.
- Secrets are redacted in everything the model, the API and the logs see.
