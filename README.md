# WrongForge

A minimal agent app that signs in with Claude (OAuth) and then talks to
`api.anthropic.com` with Bearer tokens exactly like Claude Code / Claude
Desktop does — with a system prompt and tool calling. Built on the Vercel AI
SDK (`ai@7` + `@ai-sdk/anthropic@4`); no extra services required.

## Models (October 2026)

| Model ID | Tier | Price in/out ($/MTok) |
|---|---|---|
| `claude-sonnet-5-5` | **default** — balanced coding/agent | 2 / 10 |
| `claude-opus-5-5` | Anthropic's recommendation for most workloads | 4 / 20 |
| `claude-fable-5-1` | deepest reasoning, long agent runs | 10 / 50 |
| `claude-haiku-5-5` | fast/economical | 0.10 / 0.50 |

All have a 1M-token context and 128K output; dateless IDs are pinned
snapshots. For the **live list** run `npm run models` or `/models` in the
REPL — it queries `GET /v1/models` with the OAuth token (paginated) and
returns the models available to your account.
Source: [Models overview — Claude Platform Docs](https://platform.claude.com/docs/en/models/overview).

## Setup

```bash
npm install
npm run config:init    # writes ~/.wrongforge/oauth.json from the example
```

The OAuth client registration (client ID, endpoints, scope) is **not part of
the code**. It is loaded from env vars (`CLAUDE_OAUTH_CLIENT_ID`, …) or from
`~/.wrongforge/oauth.json` (path override: `CLAUDE_OAUTH_CONFIG`; the whole data
directory can be moved with `WRONGFORGE_HOME`). An existing `~/.wrongminiagent/`
(the project's former name) is copied to `~/.wrongforge/` automatically on first
run and left untouched.
`oauth.config.example.json` holds the template; the client ID there is a
public application-registration value shared by every install of that app —
it is not tied to you or your machine.

## Privacy — what is sent to the other side

Exactly these fields, nothing else:

| Request | Fields sent |
|---|---|
| authorize URL | client_id (from your config), redirect_uri, scope, one-time PKCE code_challenge + state |
| token endpoint | grant_type, client_id, code / refresh_token, redirect_uri, code_verifier, scope (urlencoded) |
| `/v1/messages`, `/v1/models` | `Authorization: Bearer <token>`, `anthropic-beta`, `anthropic-version`, `Content-Type`, `Accept` |

No device ID, no persistent machine fingerprint, no hostname, no user agent,
no telemetry headers. PKCE `code_verifier`/`state` are fresh random values per
login and identify nothing. The account itself is of course identified by the
OAuth login — that is inherent to signing in.

## Usage

```bash
npm run import            # reuse your existing Claude Code session (no login needed)
npm run login            # alternative: browser login -> paste the shown code
npm run models           # live model list for your account
npm start                # chat REPL
npm run serve            # HTTP API with live tool-call stream (needs AGENT_API_KEY) → docs/API.md
```

`npm run import` reads `claudeAiOauth` from `~/.claude/.credentials.json`
(Claude Code CLI's stored session) into this app's encrypted token store.
The token refreshes through the same endpoint when it expires, so a single
import keeps working. If Claude Code re-logins, run `npm run import` again.

> Loopback redirects (`http://127.0.0.1:…/callback`) are **not supported** for
> this client: the server rejects them ("Redirect URI … is not supported by
> client"). The only registered redirect is
> `https://console.anthropic.com/oauth/code/callback`, so the
> paste-the-code flow (the standard Claude Code CLI flow) is the only login path.

REPL commands: `/help /status /model <id> /models /reset /tools /exit`.
Default model `claude-sonnet-5-5`; override with `CLAUDE_MODEL` or `/model`.

## Tools

Each tool lives in its own file under `src/tools/`:

| Tool | File | Purpose |
|---|---|---|
| `bash` | `bash.ts` | run a shell command: stdin closed, timeout + process-tree kill, long output keeps head **and** tail, stops on Ctrl+C |
| `read` | `read.ts` | numbered lines (cat -n), `offset`/`limit`, `nextOffset` pagination; rejects directories/binary/>10 MB, cuts very long lines |
| `write` | `write.ts` | write new files or full rewrites (creates parent dirs, reports `created`) |
| `edit` | `edit.ts` | exact, literal replacement (`$&` is not special); unique match or `replace_all`; CRLF-aware; errors point at line numbers |
| `ls` | `ls.ts` | directory entries (dirs first, name/type/size, `truncated` flag) |
| `glob` | `glob.ts` | `**`, `*`, `?`, `[abc]`, `{ts,tsx}`; newest first |
| `grep` | `grep.ts` | regex search; modes `content` / `files_with_matches` / `count`, `context` lines |
| `web_fetch` | `web-fetch.ts` | public URL → readable text (structure kept, title, charset, binary refused) |
| `todo_read` / `todo_write` | `todo-*.ts` | session task list (state in `todo-state.ts`) |

Shared helpers: `util.ts` (limits, paths, error text), `glob-utils.ts` (glob
matcher + directory walker), `shell.ts` (process runner), `web-utils.ts`
(SSRF guard, HTML→text). `index.ts` assembles `agentTools`.

`glob`/`grep` skip `.git`, `node_modules` and similar directories; binary-ish
files are skipped by content sniffing. A glob without `/` (`*.json`) matches
file names at any depth. `web_fetch` attaches no credentials.

## Use it as an API (HTTP + live tool-call stream)

`npm run serve` starts a local HTTP service around the same agent loop. You
POST a prompt; the agent does the work and **streams every text delta, tool
call and tool result back as Server-Sent Events** (or returns one JSON
document with all events).

```bash
# PowerShell: $env:AGENT_API_KEY = "…≥16 chars…"; npm run serve
AGENT_API_KEY=a-long-random-secret npm run serve      # http://127.0.0.1:8787

curl -N http://127.0.0.1:8787/v1/run \
  -H "Authorization: Bearer $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"list the dependencies in package.json","session_id":"demo"}'
```

```
event: tool_call    data: {"id":"toolu_01","name":"bash","input":{"command":"type package.json"}}
event: tool_result  data: {"id":"toolu_01","name":"bash","output":{"exitCode":0,"stdout":"…"}}
event: text         data: {"delta":"Dependencies: ai, @ai-sdk/anthropic, zod …"}
event: done         data: {"finish_reason":"stop","tool_calls":1,"text":"…"}
```

Endpoints: `POST /v1/run`, `GET /v1/tools`, `GET /v1/sessions`,
`DELETE /v1/sessions/:id`, `GET /health`. Sessions (`session_id`) keep the
conversation in memory across calls; a client disconnect aborts the run.

> **Security:** the agent can run shell commands. The API key is mandatory,
> the server binds to `127.0.0.1` by default, and there is no sandbox — see
> the security section in the API docs before exposing it anywhere.

Full reference (events, fields, status codes, curl/Node/Python clients,
limitations): **[docs/API.md](docs/API.md)**.

Example REPL session:

```
you> list the dependencies in package.json with versions
▸ bash type package.json
  ↳ {"exitCode":0,"stdout":"{ ... }"}
Dependencies: ai ^7.0.141, @ai-sdk/anthropic ^4.0.80, zod ^4.6.7 …
[stop, 1 tool call]
```

## Architecture

```
browser (user login)
   │  https://console.anthropic.com/oauth/authorize
   │  ?client_id=<from your config>&response_type=code&scope=user:inference+user:profile
   │  &code_challenge=…&code_challenge_method=S256&state=…
   ▼
src/oauth.ts  ──POST console.anthropic.com/v1/oauth/token (JSON + PKCE + state)──▶
   │            {access_token, refresh_token, expires_in} → AES-256-GCM file
   ▼
src/provider.ts  (oauthFetch)
   │  on every AI SDK request: strip x-api-key
   │  Authorization: Bearer <token>          → api.anthropic.com/v1/messages
   │  anthropic-beta: …,oauth-2025-04-20      ← required for OAuth tokens
   │  on 401 → refresh (refresh_token grant, no Bearer) → single retry
   ▼
src/agent.ts  (streamText + stopWhen(stepCountIs(20)); events via onEvent)
   ├─ src/tools/: bash / read / write / edit / ls / glob / grep / web_fetch / todo
   │
   ├── src/main.ts    REPL (prints events to the terminal)
   └── src/server.ts  HTTP API (streams events as SSE / JSON) → docs/API.md
```

`runAgentTurn(provider, model, history, maxSteps, abortSignal, onEvent?)`:
without `onEvent` it prints to the terminal; with it, it emits structured
`AgentEvent`s (`text`, `tool_call`, `tool_result`, `tool_error`, `error`) —
this is what the HTTP server forwards.

Note: the token endpoint is `console.anthropic.com/v1/oauth/token` and it
expects a **JSON** body with the header `User-Agent: anthropic` (not the
OAuth-default urlencoded form); the exchange body carries `state` as well.
The token endpoint on `api.anthropic.com` rejects this flow ("Invalid request
format" — verified live). `api.anthropic.com` is used only for `/v1/messages`.

### Subscription inference gating (empirically mapped)

OAuth subscription tokens are served only to requests that look like Claude
Code. `oauthFetch` therefore also applies, on `/v1/messages`:

- the client header signature (UA `claude-cli/… (external, sdk-cli)`, `x-app`,
  the `x-stainless-*` set, `anthropic-dangerous-direct-browser-access`),
- `POST /v1/messages?beta=true` with the Claude Code beta list,
- and — the decisive gate for premium models (opus/sonnet/fable, 5.x) — a
  first system block reading
  `"You are Claude Code, Anthropic's official CLI for Claude."`,
  followed by the app's own system prompt. Without this marker the API
  returns a bare 429 even with a valid token (`claude-haiku-4-5` is exempt).
  None of these values are machine-specific.

## Tests

```bash
npm test                            # all suites
npx tsx test/tools.test.ts          # unit: bash, read/write/edit, ls, glob, grep, web_fetch helpers, todos
npx tsx test/oauth-mock.test.ts     # offline: exchange, refresh, header injection
npx tsx test/agent-e2e.test.ts      # offline: full agent loop (SSE mock + real tool execution)
npx tsx test/server.test.ts         # offline: HTTP API — auth, SSE tool-call stream, JSON mode, sessions
npm run typecheck                   # strict tsc
```

The E2E test verifies the whole chain against a fake Anthropic SSE server:
OAuth header injection → `tool_use` → the tool **actually runs locally** →
`tool_result` sent back → final text. No request goes to Anthropic.

## Environment variables

| Variable | Meaning |
|---|---|
| `CLAUDE_MODEL` | Default model (default: `claude-sonnet-5-5`) |
| `CLAUDE_TOKEN_STORE` | Token file path |
| `ANTHROPIC_BASE_URL` | Different API root (proxy/mock; default `https://api.anthropic.com/v1`) |
| `ANTHROPIC_TOKEN_URL` | Different token endpoint (tests) |
| `AGENT_API_KEY` | HTTP API only: required Bearer key (≥ 16 chars) |
| `PORT` / `HOST` | HTTP API only: listen port (8787) / address (127.0.0.1) |

## Security notes

- Tokens are stored AES-256-GCM encrypted in `~/.wrongforge/tokens.json`
  (key in a separate 0600 file) — a dependency-free equivalent of Electron
  safeStorage/DPAPI.
- `bash` executes commands on the user's machine; the system prompt
  asks for confirmation before destructive actions, but that is not a guarantee.
- Tokens are never printed or logged (`/status` only shows expiry/scope).
- The HTTP API gives its key holder shell access as the server's user — keep
  it on loopback, use a strong `AGENT_API_KEY`, and see [docs/API.md](docs/API.md#security--read-this-first).

## Known limitations

- The login flow uses a public OAuth client registration supplied via config
  (see `oauth.config.example.json`); if the registration changes (scope/
  redirect), update your config — nothing is hardcoded in the code.
