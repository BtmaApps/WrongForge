# Changelog

Notable changes to WrongForge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match
package.json and the git tags that drive the release workflow.

## [Unreleased]

### Fixed
- **`wrongforge update` (and `WRONGFORGE_AUTO_UPDATE`) always refused to run**
  with "self-update replaces the compiled binary" — on every binary, every
  platform, since the feature shipped (GitHub issue #2). `isCompiledBinary()`
  also required `process.argv[0]` to contain `"wrongforge"`, but in a Bun
  `--compile` executable `argv[0]` is always the fixed string `"bun"` (the
  runtime name), never the executable's own path — confirmed by compiling
  and running a real binary. Fixed by dropping that check; `process.execPath`
  (the real on-disk path) was already reliable on its own. Verified against
  both a freshly-compiled local binary and a real published release.
- **A clean binary install had no way to refresh its OAuth token**
  (`OAuth client is not configured`, `wrongforge status` showing
  `clientConfigured: false` — GitHub issue #4): `scripts/install.sh` /
  `install.ps1` only ever installed the binary, never the OAuth client
  config (`npm run config:init`, the only existing way to create it, is
  source-only). Both installers now write `~/.wrongforge/oauth.json` (or
  `install.ps1`'s `%USERPROFILE%\.wrongforge\oauth.json`, respecting
  `WRONGFORGE_HOME`) from the repo's public `oauth.config.example.json` when
  it doesn't already exist — client identifiers still live outside the
  source (no policy change), the installer just automates the copy. A
  failed download never fails the install.

## [0.4.8] — 2026-10-19

### Added
- **Dashboard "Proxy" tab: human-readable request/response summaries**
  instead of a flat "raw" button. Model, message/tool counts and the last
  message's content (text/tool_use/tool_result/thinking) for requests;
  finish reason, token usage and reply content for responses — for
  streaming calls too, by replaying the raw SSE event text (`proxy.ts`
  never reconstructs it server-side) into an approximate final message
  client-side. Click still opens the full raw JSON, unchanged
  (`webui/src/lib/anthropicSummary.ts`). Also fixed the Sessions tab's
  message preview, which never actually summarized a stored tool call: it
  checked for the Anthropic wire format's `tool_use`/`name` instead of the
  stored session format's `tool-call`/`toolName` (`src/messages.ts`), so
  every tool call fell through to a generic `(tool-call)` placeholder; now
  shows `⇢ toolName(input)`.

## [0.4.7] — 2026-10-18

### Added
- **`wrongforge refresh`** (`npm run refresh`): a lightweight, serve-independent
  way to use the refresh token on demand. `serve`'s own idle keep-alive only
  runs while the server is up; reverse-engineering Claude Code found that the
  refresh token itself dies after roughly 30 days of disuse (renewed on every
  successful refresh — `re/notes/findings.md` §14). Running this on a shorter
  schedule (cron, systemd timer, Windows Task Scheduler) keeps a long-idle
  session alive without ever running real Claude Code. Deliberately not a
  bare token-endpoint call: carved CC never refreshes in isolation either
  (every refresh site found guards a real request and fires right before
  one), so this follows the refresh with the same `GET /v1/models`
  `wrongforge models` already makes — keeping the traffic inside a shape
  real CC also produces, and confirming the token actually works.
- `oauth.status()` now reports `refreshTokenExpiresAt` (null when the token
  endpoint hasn't sent it — not "never expires") alongside the access token's
  expiry.

### Fixed
- `src/oauth.ts` now records `refresh_token_expires_in` from the token
  endpoint when present, carrying the previous value forward on a refresh
  response that omits it (mirrors Claude Code's own merge behavior) instead
  of discarding it.
- **`context_overflow` from a single oversized tool result** (reported via
  WrongStack): a tool result could push a request past the model's context
  window (up to a hard `400`) without the in-task guard ever reacting, because
  it only checks the API's own usage numbers from the *previous* response —
  which don't yet include a result just appended, and arrive one request too
  late for a result that alone jumps past the limit. Also, nothing bounded
  the size of a tool result generically: built-in tools already self-limit
  their own output, but MCP/gateway tools did not. Fixed with two new
  defenses (`src/compaction.ts`, `src/agent.ts`): (1) any single tool result
  bigger than `WRONGFORGE_MAX_TOOL_OUTPUT_CHARS` (default 400 000 chars) is
  clipped the moment it comes back, regardless of which tool produced it; (2)
  the in-task guard now also re-checks right after a tool result is
  appended, using a same-turn character-count estimate of that result (the
  real usage numbers still win on the next response — the estimate only
  decides *when* the guard reacts).
- **Cache-control TTL ordering error** (`a ttl='1h' cache_control block must
  not come after a ttl='5m' cache_control block`, reported via WrongStack on
  a long-running session): a task could pick its own prompt-cache mode
  (`5m`/`1h`/`off`) independent of what earlier tasks on the same
  `session_id` had used — and since `cache.ts` only ever marks the newest
  message (never touching an older `cache_control` already embedded in
  history), mixing modes across a session's turns could leave an
  inconsistent TTL ordering the API rejects outright, with no way for the
  session to recover on its own. Fixed: a session's cache mode is now locked
  in by its **first** turn (`SessionMeta.cache_mode`) — every later task's
  `cache` request is silently overridden to match (logged as
  `session.cache_mode_locked`); and the rare case where this error still
  occurs is now recognized (`isCacheOrderingError`) and recovered from
  exactly like `context_overflow` — the session is flagged and compacts
  automatically on the next task (new `cache_ordering_error` error code).
  Also, the cache-rejection fallback (disabling `cache_control` after the
  API refuses it) is now scoped **per session** instead of process-wide — a
  single broken session no longer silently turns off caching for every
  other session the server is also handling.
- **A failed task reported no `result` at all on `context_overflow` and
  `cache_ordering_error`** — a caller got the error message but never
  `context_tokens`/`context_window`/`context_percent`, so there was no way
  to tell how close it got (only that it failed). Both now include `result`
  whenever a turn actually ran, same as every other failure mode.

## [0.4.6] — 2026-10-18

### Added
- **Automatic self-update** (`WRONGFORGE_AUTO_UPDATE=1`, off by default):
  `serve` installs a newer release on its own once the server is idle (no
  queued/running task) — a release already found by the existing daily check
  is downloaded and sha256-verified while still fully serving, and only once
  that succeeds does it close the listening port and install it. Compiled
  binary only, same as `wrongforge update`. `WRONGFORGE_AUTO_UPDATE_POLL_MS`
  (default 2 min) controls how often the idle+update-available condition is
  checked. `/v1/info` → `auto_update: { enabled, supervised }`.
- **Crash-restart supervisor** (`WRONGFORGE_SUPERVISE=1`, off by default):
  `serve` runs the real server as a child and restarts it on exit — crash or
  otherwise — with capped exponential backoff (1 s → 60 s, reset after a
  minute of uptime). Its own `Ctrl+C`/`SIGTERM` is forwarded to the child and
  does not trigger a restart. Combine both for a self-healing,
  self-updating server: `WRONGFORGE_SUPERVISE=1 WRONGFORGE_AUTO_UPDATE=1
  wrongforge serve`. See `docs/RELEASE.md`.
- `src/update.ts`: `selfUpdate()` split into `prepareUpdate()` (network:
  check, download, sha256 verify) and `installUpdate()` (filesystem: swap +
  respawn + exit) — `wrongforge update` still calls both in sequence; the
  split is what lets the automatic path verify an update before tearing
  anything down for it.

## [0.4.5] — 2026-10-18

### Added
- **Dashboard "Proxy" tab**: live visibility into every call to the
  Anthropic-compatible endpoint (`/v1/messages`, `/v1/messages/count_tokens`,
  `/v1/models`) — method, model, `stream`/`auth_mode`, status, duration, and
  the request/response bodies themselves (expandable). Fed by a new
  `proxy.call` SSE channel on `GET /v1/events`, kept separate from the task
  event firehose so its (larger) bodies never crowd it out. Capturing a
  response never buffers or delays what the real client receives — it mirrors
  a size-capped copy alongside the untouched pass-through pipe
  (`WRONGFORGE_PROXY_TAP_BODY_CAP`, default 8 KB; independent of
  `WRONGFORGE_PROXY_MAX_BODY`, which bounds what the proxy itself accepts).

## [0.4.4] — 2026-10-18

### Fixed
- **Login grant scope narrowed without `code=true`** (issue #3, community
  report + `re/notes/findings.md` §12): the authorize-URL request was missing
  a parameter Claude Code always sends (`code=true`), carved from CC 2.1.300's
  own builder. Without it the granted scope could come back missing
  `user:inference` (model calls then fail even though sign-in looked fine).
  Added; the OAuth client (console/subscription) endpoint choice itself was
  already correct — confirmed scope selection is unrelated to the host.
- `src/oauth.ts`'s outdated note claiming `api.anthropic.com` rejects the
  token-endpoint request shape is removed — independently probe-verified by a
  community report that it currently accepts it (any User-Agent). WrongForge
  keeps targeting `platform.claude.com` (Claude Code's own `TOKEN_URL`) rather
  than relying on that undocumented leniency.

## [0.4.3] — 2026-10-18

### Added
- **Anthropic-compatible endpoint** — the server now mirrors the Anthropic
  Messages API itself (`POST /v1/messages` streaming and non-streaming,
  `POST /v1/messages/count_tokens`, `GET /v1/models[/:id]`). Any Anthropic
  client (Claude Code, the SDKs, WrongStack) can point `ANTHROPIC_BASE_URL`
  at WrongForge and use the server's credentials: with OAuth the request
  rides the same Claude Code client signature the agent uses (subscription
  billing, 401 auto-refresh, 400 self-heal); with `ANTHROPIC_API_KEY` it is a
  byte-for-byte passthrough. Client auth accepts `x-api-key` in addition to
  Bearer on the whole API. Responses (status, SSE, rate-limit headers, error
  envelopes) pass through untouched. `WRONGFORGE_PROXY=0` disables the
  surface; `WRONGFORGE_PROXY_MAX_BODY` caps bodies (default 32 MB).
- **OAuth idle keep-alive:** the server now refreshes its session on its own
  while running (checks every `WRONGFORGE_TOKEN_KEEPALIVE_MS`, default 5 min;
  refreshes once the access token has <15 min left, with exponential backoff
  after failures). An idle server used to leave the token chain untouched
  between tasks until the refresh token died of disuse — the "run Claude Code
  once in a while" ritual; running the server is now enough.

### Fixed
- **Import and self-healing after Claude Code 2.1.302** (issue #3): Claude
  Code moved its credentials from `~/.claude/.credentials.json` into the macOS
  Keychain. `import` (and the automatic session recovery after a dead refresh
  token) now falls back to reading the Keychain item `Claude Code-credentials`
  when the legacy file is gone, so no manual `security find-generic-password`
  export or launchd cron is needed.
- **Token exchange / refresh 429s — root cause found and probe-verified**
  (issue #3, `re/notes/findings.md` §11): the token endpoint 429-rate-limits
  the generic `User-Agent: anthropic` WrongForge sent — the same JSON request
  with a `claude-cli/…` UA (or no UA) is processed normally. The request now
  carries the Claude Code user-agent, the refresh body includes the granted
  `scope` (both carved from CC 2.1.300), and the default OAuth endpoints moved
  to `platform.claude.com` — the old `console.anthropic.com/v1/oauth/token`
  now answers 404. Existing `oauth.json` / env overrides keep winning.

## [0.4.2] — 2026-10-16

### Fixed
- Import Claude Code credentials containing a UTF-8 BOM and distinguish
  unreadable files, malformed JSON and missing access tokens in diagnostics.
- Keep normal CLI errors concise; retain stack traces with `WRONGFORGE_DEBUG`.
- Stop webhook retries and queued deliveries when the task manager shuts down.

### Added
- Regression tests for credential diagnostics, CLI debug output and webhook
  shutdown. Releases now require typecheck, the full test suite and a native
  binary version check on Windows, Linux and macOS before publication.

## [0.4.1] — 2026-10-16

### Fixed
- Recover incomplete session records after crashes and preserve sessions when
  compaction reaches its output limit.
- Harden OAuth refresh races, task deadlines, MCP connection shutdown and
  overlapping maintenance passes.
- Improve self-update rollback handling, web address validation and dashboard
  event replay across reconnects.

### Added
- **One-line installers** — `curl … install.sh | bash` (Linux/macOS) and
  `irm … install.ps1 | iex` (Windows): sha256-verified download from the
  latest release, PATH setup, macOS quarantine clearing. Release checksums
  are now computed once over all platform binaries (SHA256SUMS.txt covers
  every asset).

## [0.4.0] — 2026-10-16

The binary release: WrongForge ships as a single executable, keeps itself
current, and its requests are byte-faithful to a real Claude Code client.

### Added
- **Single-file executable** — `npm run build:binary` compiles with Bun
  (`--compile`): the webui dashboard and the default prompt guides are
  embedded; no Node, no npm, no `webui/dist` needed on the target machine.
  Binary commands: `wrongforge serve | update | version` plus the source-mode
  commands. ([docs/RELEASE.md](docs/RELEASE.md))
- **GitHub Releases** — pushing a `v*` tag builds Windows, Linux and macOS executables (macOS arm64 + x64)
  with sha256 checksums and attaches them to a release
  (`.github/workflows/release.yml`, repo `WrongStack/WrongForge`).
- **Update checks & self-update** — `serve` checks `releases/latest` at
  startup and daily; a newer version surfaces in the serve banner, the log,
  `/v1/info.update` and as a red dashboard chip. `wrongforge update`
  downloads the platform asset, verifies its sha256 digest against the
  release metadata, swaps the running executable in place (Windows-safe
  rename dance) and respawns with the same arguments. Kill switches:
  `WRONGFORGE_UPDATE_CHECK=0`, `WRONGFORGE_UPDATE_REPO`.
- **Request parity with Claude Code 2.1.300** (reverse-engineered from
  captured traffic + the carved executable): the exact 15-beta list in the
  captured order, `count_tokens` preflight before every streaming turn, the
  `/api/hello` startup ping, `thinking: adaptive`, `context_management`,
  the `safeguards` dangerous-tool-use classifier context, `max_tokens`
  128000 on main turns, pinned `x-stainless-runtime-version`
  (`v26.3.0`), SDK retry-count preserved. Each injected field self-heals
  away with a retry when an endpoint refuses it.
- **Effort, actually working** — `effort` rides inside `output_config`
  behind the `effort-2025-11-24` beta (the old top-level field was rejected
  with "Extra inputs are not permitted"; live-verified accepted now). Five
  levels `low|medium|high|xhigh|max` (+`off`), capability table mirroring
  CC's model list, per-model levels served in `/v1/info` → `model_details`
  and shown in `npm run models`. Learned rejections persist 7 days.
- **Gateway tool shadowing** — an orchestrator tool named `<prefix><built-in>`
  (`wstack_read`) now hides that built-in from the model, deterministically
  routing the operation through the orchestrator (`gateway.shadow_builtins:
  false` to keep both; live-verified end-to-end).
- **OAuth self-healing** — when the refresh token dies, WrongForge adopts
  Claude Code's own session from `~/.claude/.credentials.json`
  automatically and refreshes it; the manual `npm run import` ritual is only
  needed when Claude Code's token is dead too.
- **Dashboard: Info tab** (models & effort levels, plan usage 5h/weekly,
  limits, tools, storage) and **Insights tab** (per-model usage/outcomes,
  tool activity — replaces the old React-Flow graph; `@xyflow/react`
  removed, bundle −33%).
- **Backlog replay for task events** — `/v1/events` now replays the newest
  ≤300 task events **from disk** on connect (plus the http traffic ring), so
  a dashboard opened late — or after a serve restart — still shows the
  rounds, tool calls and texts that ran while it was away.
- Dashboard actions: **run a test task / test request** buttons, task
  cancel, idle diagnostics strip, one-screen control-room layout
  (task rail | live feed | inspector).

### Changed
- `/v1/info` exposes `model_details`, `workdir.suggestion`, `limits`,
  `webhook`, `dirs` and `update`; `effort.levels` includes `xhigh`/`max`.
- `docs/INTEGRATION.md` and `docs/TASKS-API.md` updated for all of the
  above; new `docs/RELEASE.md`.
- Project license: **MIT**.

## [0.3.0] — 2026-10-15

The billing breakthrough and the first dashboard.

- **Plan billing solved** — requests carry the Claude Code client signature:
  the `x-anthropic-billing-header` system block (captured from a real CC
  run through a local proxy), client UA/`x-app`/`x-stainless-*` headers and
  the CC beta set. Subscription-plan billing and prompt caching work
  end-to-end.
- **Migration to the official SDKs** — `@anthropic-ai/sdk` + the official MCP
  SDK (finish-reason vocabulary, baseURL normalization).
- **Live web dashboard** (React 19 + Radix + Vite, served at `/` with
  `?key=` auth): live event firehose with `step.request` (what went out to
  the model) / `step.finished` (what came back), task table, sessions,
  graph.
- **HTTP traffic monitoring** — `http.request` frames on the global SSE
  feed, the serve-console live view (`src/liveview.ts`) and SSE backlog
  replay of recent requests.
- **Tool-schema flattening** — gateway/MCP tool schemas with top-level
  `oneOf`/`anyOf`/`allOf` are flattened before `/v1/messages` (live 400
  incident fixed).
- Model-aware reasoning effort (initial version, top-level field),
  `WRONGFORGE_EFFORT`, `/effort` REPL command.

## [0.2.0] — 2026-10-15

The orchestrator surface.

- Durable **task store** (`tasks/<id>/task.json` + `events.jsonl`), event
  replay, heartbeats, timeouts, cancellation, recovery after restarts.
- **HTTP task API** — submit (wait/stream/async), status, events (SSE /
  long-poll / replay), global `/v1/events` feed, signed webhooks with
  retries, `/v1/sessions` with compaction, maintenance.
- **Tool gateway** — orchestrator-lent tools over HTTP (discovery or
  inline, allow/deny, name prefix `wstack_`, schema flattening).
- **MCP servers** — config file, typed `mcp_*` tools, per-task selection,
  management API + REPL tools.
- REPL (`npm start`) with `/model`, `/effort`, `/status`, `/usage`.

## [0.1.0] — 2026-10-15

Initial release: the agent itself — OAuth sign-in (login/import), the tool
set (bash, read/write/edit, ls/glob/grep, web_fetch, todos,
report_progress), the Claude turn loop with streaming, prompt guides,
configuration and the data directory.
