# Changelog

Notable changes to WrongForge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match
package.json and the git tags that drive the release workflow.

## [Unreleased]

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
