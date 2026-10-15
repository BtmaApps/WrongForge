# WrongForge documentation

WrongForge's HTTP API is the **task API** (`/v1/tasks`). An older synchronous
`POST /v1/run` endpoint, which this file used to describe, no longer exists.

| Document | Read it for |
|---|---|
| [TASKS-API.md](TASKS-API.md) | **Protocol reference** — authentication, submitting tasks, task document, lifecycle and error codes, events, SSE / long-poll, webhooks, sessions, limits |
| [INTEGRATION.md](INTEGRATION.md) | **Guide for building a client** — setup checklist, following a task, sessions, parallelism and workdirs, reliability patterns, client examples (Node, Python, webhook receiver), operations, troubleshooting |
| [TOOL-GATEWAY.md](TOOL-GATEWAY.md) | Lending the orchestrator's own tools to the agent over HTTP |
| [MCP.md](MCP.md) | Configuring and using MCP servers (CLI, HTTP management, per-task selection) |
| [../README.md](../README.md) | Overview, setup, privacy, tools, configuration (all environment variables), data directory |

Quick start:

```bash
npm run import          # once: reuse your Claude Code session (or `npm run login`)
npm run serve           # prints the URL and the API key

curl -N http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"list the dependencies in package.json","workdir":"D:/work/app","stream":true}'
```

The code is the source of truth: `src/server.ts` (routes),
`src/tasks/types.ts` (protocol types), `src/tasks/manager.ts` (validation and
lifecycle).
