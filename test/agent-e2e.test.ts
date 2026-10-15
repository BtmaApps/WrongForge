/**
 * End-to-end (offline) agent test: with a fake Anthropic SSE server, run the
 * full loop — oauthFetch header injection -> streamText -> tool_use ->
 * local tool execution -> tool_result sent back -> final text response.
 *
 *   npx tsx test/agent-e2e.test.ts
 */

import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ModelMessage } from "ai";
import { ClaudeOAuth } from "../src/oauth.js";
import { createClaudeProvider } from "../src/provider.js";
import { runAgentTurn, DEFAULT_MODEL } from "../src/agent.js";

/** Writes one SSE event. */
function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`event: ${String((obj as any).type)}\ndata: ${JSON.stringify(obj)}\n\n`);
}

function toolUseResponse(res: http.ServerResponse): void {
  const msg = {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  };
  sse(res, { type: "message_start", message: msg });
  sse(res, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_01", name: "ls", input: {} },
  });
  sse(res, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":".' + '"' + "}" },
  });
  sse(res, { type: "content_block_stop", index: 0 });
  sse(res, {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 15 },
  });
  sse(res, { type: "message_stop" });
  res.end();
}

function textResponse(res: http.ServerResponse): void {
  const msg = {
    id: "msg_text",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 20, output_tokens: 1 },
  };
  sse(res, { type: "message_start", message: msg });
  sse(res, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  sse(res, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "The directory contains 3 files: a.ts, b.ts, c.ts." },
  });
  sse(res, { type: "content_block_stop", index: 0 });
  sse(res, {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 12 },
  });
  sse(res, { type: "message_stop" });
  res.end();
}

function main(): Promise<void> {
  return new Promise((resolve, reject) => {
    const messagesRequests: {
      headers: http.IncomingHttpHeaders;
      body: any;
    }[] = [];
    let tokenCalls = 0;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");

        if (req.url === "/v1/oauth/token") {
          tokenCalls++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "at-e2e",
              refresh_token: "rt-e2e",
              expires_in: 3600,
              scope: "user:inference user:profile",
            }),
          );
          return;
        }

        if (req.url?.startsWith("/v1/messages")) {
          const parsed = JSON.parse(bodyText);
          messagesRequests.push({ headers: req.headers, body: parsed });
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          // 1st request -> tool_use; 2nd request (contains tool_result) -> text
          if (messagesRequests.length === 1) toolUseResponse(res);
          else textResponse(res);
          return;
        }

        res.writeHead(404).end();
      });
    });

    server.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const base = `http://127.0.0.1:${port}`;
        process.env.ANTHROPIC_TOKEN_URL = `${base}/v1/oauth/token`;
        process.env.ANTHROPIC_BASE_URL = `${base}/v1`;
        process.env.CLAUDE_OAUTH_CLIENT_ID = "test-client-id";

        // temp store under the OS temp dir, removed on exit (pass or fail)
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongminiagent-e2e-"));
        process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
        const oauth = new ClaudeOAuth(path.join(tmp, "tokens.json"));
        // exchange directly against the fake endpoint (skips the login flow)
        await oauth.exchangeCode(
          "code-e2e",
          "verifier-e2e",
          "https://console.anthropic.com/oauth/code/callback",
          "user:inference user:profile",
        );

        const provider = createClaudeProvider(oauth);
        const history: ModelMessage[] = [
          { role: "user", content: "What is in this directory?" },
        ];
        const result = await runAgentTurn(provider, DEFAULT_MODEL, history);

        // --- assertions ---
        const assert = (cond: boolean, label: string) => {
          if (!cond) throw new Error(`assertion failed: ${label}`);
        };

        assert(messagesRequests.length === 2, "two LLM steps (tool + final)");
        assert(tokenCalls === 1, "token fetched once");

        for (const [i, r] of messagesRequests.entries()) {
          assert(
            r.headers["authorization"] === "Bearer at-e2e",
            `request ${i + 1}: Bearer injected`,
          );
          assert(
            String(r.headers["anthropic-beta"]).includes("oauth-2025-04-20"),
            `request ${i + 1}: oauth beta header`,
          );
          assert(
            !r.headers["x-api-key"],
            `request ${i + 1}: no x-api-key`,
          );
          const sys = r.body.system;
          const sysText =
            typeof sys === "string"
              ? sys
              : Array.isArray(sys)
                ? sys.map((b: any) => b?.text ?? "").join("")
                : "";
          assert(sysText.length > 50, `request ${i + 1}: system prompt sent`);
          assert(
            Array.isArray(sys) &&
              typeof sys[0]?.text === "string" &&
              sys[0].text.startsWith("You are Claude Code"),
            `request ${i + 1}: Claude Code system marker is the first system block`,
          );
          const toolNames = (r.body.tools ?? []).map((t: any) => t.name);
          assert(
            [
              "bash",
              "read",
              "write",
              "edit",
              "ls",
              "glob",
              "grep",
              "web_fetch",
              "todo_read",
              "todo_write",
            ].every((n) => toolNames.includes(n)),
            `request ${i + 1}: all 10 tool definitions sent`,
          );
        }

        const second = messagesRequests[1].body.messages as any[];
        const toolResult = JSON.stringify(second);
        assert(
          toolResult.includes("tool_result") && toolResult.includes("toolu_01"),
          "2nd request contains the tool_result",
        );

        assert(result.toolCalls === 1, "one tool call happened");
        assert(history.length >= 4, "assistant+tool messages appended to history");

        server.close();
        console.log("AGENT E2E PASSED ✓ (OAuth headers + tool loop + SSE)");
        resolve();
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
