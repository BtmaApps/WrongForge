/**
 * WrongForge HTTP API — send a prompt, receive every text delta, tool
 * call and tool result as a live event stream (SSE) or as one JSON response.
 *
 *   AGENT_API_KEY=secret npm run serve
 *
 *   POST   /v1/run             { prompt, session_id?, model?, max_steps?, stream? }
 *   GET    /v1/sessions        list sessions
 *   DELETE /v1/sessions/:id    drop a session's history
 *   GET    /v1/tools           tool names + descriptions
 *   GET    /health             no auth
 *
 * Auth: `Authorization: Bearer <AGENT_API_KEY>` (the server refuses to start
 * without a key — the agent can run shell commands on this machine).
 * Env: PORT (8787), HOST (127.0.0.1), CLAUDE_MODEL, CLAUDE_TOKEN_STORE.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import type { ModelMessage } from "ai";
import { ClaudeOAuth } from "./oauth.js";
import { APP_NAME } from "./paths.js";
import { createClaudeProvider } from "./provider.js";
import { agentTools } from "./tools/index.js";
import { runAgentTurn, DEFAULT_MODEL, type AgentEvent } from "./agent.js";

interface Session {
  history: ModelMessage[];
  busy: boolean;
  updatedAt: number;
}

const MAX_BODY = 1_000_000;
const MAX_SESSIONS = 100;

export interface ServerOptions {
  apiKey: string;
  oauth: ClaudeOAuth;
  defaultModel?: string;
}

export function createAgentServer(opts: ServerOptions): http.Server {
  const provider = createClaudeProvider(opts.oauth);
  const defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
  const sessions = new Map<string, Session>();
  const keyBuf = Buffer.from(opts.apiKey);

  const authorized = (req: http.IncomingMessage): boolean => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return false;
    const got = Buffer.from(m[1]!);
    return got.length === keyBuf.length && crypto.timingSafeEqual(got, keyBuf);
  };

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(data),
    });
    res.end(data);
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  function getSession(id: string): Session {
    let s = sessions.get(id);
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) {
        // evict the least recently used idle session
        const idle = [...sessions.entries()]
          .filter(([, v]) => !v.busy)
          .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (idle) sessions.delete(idle[0]);
      }
      s = { history: [], busy: false, updatedAt: Date.now() };
      sessions.set(id, s);
    }
    return s;
  }

  async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: any;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      return json(res, 400, { error: `invalid JSON body: ${(e as Error).message}` });
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return json(res, 400, { error: "`prompt` (non-empty string) is required" });
    const sessionId =
      typeof body.session_id === "string" && body.session_id ? body.session_id : crypto.randomUUID();
    const model = typeof body.model === "string" && body.model ? body.model : defaultModel;
    const maxSteps = Number.isInteger(body.max_steps)
      ? Math.min(Math.max(body.max_steps, 1), 100)
      : 20;
    const stream = body.stream !== false; // default: SSE

    if (!opts.oauth.signedIn) {
      return json(res, 503, { error: "agent is not signed in (run `npm run import` or `npm run login`)" });
    }
    const session = getSession(sessionId);
    if (session.busy) {
      return json(res, 409, { error: "session is busy with another run", session_id: sessionId });
    }
    session.busy = true;

    const abort = new AbortController();
    // client went away before we finished -> stop the run
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const mark = session.history.length;
    session.history.push({ role: "user", content: prompt });

    const events: AgentEvent[] = [];
    let seq = 0;
    const emit = (name: string, data: unknown): void => {
      if (stream && !res.writableEnded) {
        res.write(`id: ${seq}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      seq++;
    };

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    }
    emit("start", { session_id: sessionId, model });

    try {
      const r = await runAgentTurn(provider, model, session.history, maxSteps, abort.signal, (e) => {
        events.push(e);
        emit(e.type, e);
      });
      if (r.finishReason === "aborted") {
        session.history.length = mark;
        emit("done", { finish_reason: "aborted", tool_calls: r.toolCalls });
        if (!stream) return json(res, 499, { error: "aborted" });
      } else {
        const done = {
          session_id: sessionId,
          model,
          finish_reason: r.finishReason,
          tool_calls: r.toolCalls,
          text: r.text,
        };
        emit("done", done);
        if (!stream) return json(res, 200, { ...done, events });
      }
    } catch (e) {
      session.history.length = mark; // drop the failed turn
      const msg = abort.signal.aborted ? "aborted" : (e as Error).message;
      emit("error", { type: "error", error: msg });
      if (!stream) return json(res, abort.signal.aborted ? 499 : 500, { error: msg });
    } finally {
      session.busy = false;
      session.updatedAt = Date.now();
      if (stream && !res.writableEnded) res.end();
    }
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    void (async () => {
      try {
        if (route === "GET /health") return json(res, 200, { ok: true, name: APP_NAME, signedIn: opts.oauth.signedIn });
        if (!authorized(req)) {
          res.setHeader("WWW-Authenticate", "Bearer");
          return json(res, 401, { error: "unauthorized" });
        }
        if (route === "POST /v1/run") return await handleRun(req, res);
        if (route === "GET /v1/tools") {
          return json(res, 200, {
            tools: Object.entries(agentTools).map(([name, t]) => ({ name, description: t.description })),
          });
        }
        if (route === "GET /v1/sessions") {
          return json(res, 200, {
            sessions: [...sessions.entries()].map(([id, s]) => ({
              id,
              messages: s.history.length,
              busy: s.busy,
              updated_at: new Date(s.updatedAt).toISOString(),
            })),
          });
        }
        const del = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
        if (req.method === "DELETE" && del) {
          const id = decodeURIComponent(del[1]!);
          const s = sessions.get(id);
          if (!s) return json(res, 404, { error: "no such session" });
          if (s.busy) return json(res, 409, { error: "session is busy" });
          sessions.delete(id);
          return json(res, 200, { deleted: id });
        }
        return json(res, 404, { error: "not found" });
      } catch (e) {
        if (!res.headersSent) json(res, 500, { error: (e as Error).message });
        else res.end();
      }
    })();
  });
}

// ---- CLI entry ----
const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey || apiKey.length < 16) {
    console.error("Set AGENT_API_KEY (at least 16 characters) — the agent can execute shell commands.");
    process.exit(1);
  }
  const oauth = new ClaudeOAuth(process.env.CLAUDE_TOKEN_STORE || undefined);
  if (!oauth.signedIn) console.error("warning: not signed in yet — /v1/run answers 503 until you run `npm run import`.");
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  const server = createAgentServer({
    apiKey,
    oauth,
    defaultModel: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
  });
  server.listen(port, host, () => {
    console.log(`WrongForge API listening on http://${host}:${port}  (model: ${process.env.CLAUDE_MODEL || DEFAULT_MODEL})`);
  });
}
