/**
 * Offline end-to-end test: with a fake token + messages server, verify
 * exchange -> (on expiry) proactive refresh -> oauthFetch header injection.
 *
 *   npx tsx test/oauth-mock.test.ts
 */

import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ClaudeOAuth, parsePastedCode } from "../src/oauth.js";
import { oauthFetch } from "../src/provider.js";

// Temp dirs live under the OS temp dir and are removed on exit (pass or fail).
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// console.assert only logs; this throws so a failed check fails the test.
function check(cond: unknown, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

// --- parsePastedCode: "code#state" is what the redirect page shows ---
check(parsePastedCode("ABC", "S") === "ABC", "bare code accepted");
check(
  parsePastedCode("ABC#S", "S") === "ABC",
  "code#state splits and state validates",
);
check(
  parsePastedCode("https://x/cb?code=ABC&state=S", "S") === "ABC",
  "full callback URL accepted",
);
try {
  parsePastedCode("ABC#OTHER", "S");
  check(false, "state mismatch must throw");
} catch (e) {
  check(/state mismatch/.test((e as Error).message), "state mismatch error");
}
let emptyThrew = false;
try {
  parsePastedCode("   ", "S");
} catch {
  emptyThrew = true;
}
check(emptyThrew, "empty code must throw");

function main(): Promise<void> {
  return new Promise((resolve, reject) => {
    const seen: {
      tokenRequests: any[];
      messagesHeaders: http.IncomingHttpHeaders | null;
    } = { tokenRequests: [], messagesHeaders: null };
    let tokenCall = 0;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/v1/oauth/token") {
          seen.tokenRequests.push({
            headers: req.headers,
            body: JSON.parse(body),
          });
          tokenCall++;
          // first call: 429 with Retry-After: 0 (exercises the retry path),
          // then a 1s-TTL token (proactive refresh), then a 1h token
          if (tokenCall === 1) {
            res.writeHead(429, {
              "Content-Type": "application/json",
              "Retry-After": "0",
            });
            res.end(
              JSON.stringify({
                error: { type: "rate_limit_error", message: "Rate limited. Please try again later." },
              }),
            );
            return;
          }
          const exchange = tokenCall === 2;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: exchange ? "at-1" : "at-2",
              refresh_token: exchange ? "rt-1" : "rt-2",
              expires_in: exchange ? 1 : 3600,
              scope: "user:inference user:profile",
            }),
          );
          return;
        }
        if (req.url?.startsWith("/v1/messages")) {
          seen.messagesHeaders = req.headers;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_test",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              model: "claude-sonnet-5-5",
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
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
        process.env.CLAUDE_OAUTH_CLIENT_ID = "test-client-id";
        const store = path.join(
          mkTmp("wrongminiagent-login-test-"),
          "tokens.json",
        );
        const oauth = new ClaudeOAuth(store);

        // 1) authorization_code exchange (first attempt is a 429 that is retried)
        await oauth.exchangeCode(
          "test-code",
          "test-verifier",
          "https://console.anthropic.com/oauth/code/callback",
          "user:inference user:profile",
          "test-state",
        );
        check(
          seen.tokenRequests.length >= 2 &&
            seen.tokenRequests.every((t: any) => t.body.grant_type === "authorization_code"),
          "429 was retried with the same grant",
        );
        const ex = seen.tokenRequests[1];
        check(
          ex.body.grant_type === "authorization_code" &&
            ex.body.code === "test-code" &&
            ex.body.code_verifier === "test-verifier" &&
            ex.body.state === "test-state" &&
            ex.body.client_id === "test-client-id",
          "exchange body is correct",
        );
        check(
          String(ex.headers["content-type"]).includes("application/json"),
          "token endpoint receives a JSON body",
        );
        check(
          ex.headers["user-agent"] === "anthropic",
          "token endpoint receives the anthropic User-Agent",
        );
        check(
          !("authorization" in ex.headers),
          "no Bearer on the token exchange (nor on refresh)",
        );

        // 2) 1s TTL -> proactive refresh must kick in
        await new Promise((r) => setTimeout(r, 1100));
        const token = await oauth.getAccessToken();
        if (token !== "at-2") throw new Error(`refresh did not happen: ${token}`);
        const rf = seen.tokenRequests[2];
        check(
          rf.body.grant_type === "refresh_token" &&
            rf.body.refresh_token === "rt-1",
          "refresh body is correct",
        );

        // 3) oauthFetch: Bearer + beta injection
        const f = oauthFetch(oauth);
        const res = await f(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "must-not-be-seen",
            "anthropic-beta": "interleaved-thinking-2025-05-14",
          },
          body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
        });
        if (res.status !== 200) throw new Error(`messages HTTP ${res.status}`);
        const h = seen.messagesHeaders!;
        check(
          h["authorization"] === "Bearer at-2",
          `Bearer injected: ${h["authorization"]}`,
        );
        check(
          !h["x-api-key"],
          "x-api-key stripped",
        );
        const beta = String(h["anthropic-beta"]);
        check(
          beta.includes("oauth-2025-04-20") &&
            beta.includes("interleaved-thinking-2025-05-14"),
          `beta headers merged: ${beta}`,
        );

        // 4) import from a Claude Code credentials file (no network)
        const credFile = path.join(
          mkTmp("claude-import-test-"),
          ".credentials.json",
        );
        fs.writeFileSync(
          credFile,
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "imported-at",
              refreshToken: "imported-rt",
              expiresAt: Date.now() + 3600_000,
              scopes: ["user:inference", "user:profile"],
            },
          }),
        );
        const oauth2 = new ClaudeOAuth(path.join(path.dirname(credFile), "tokens.json"));
        const imported = oauth2.importFromClaudeCode(credFile);
        if (imported.accessToken !== "imported-at") throw new Error("import failed");
        const viaImport = await oauth2.getAccessToken();
        if (viaImport !== "imported-at") throw new Error("imported token not usable");
        check(oauth2.signedIn, "import marks the session as signed in");

        // 5) self-healing: a rejected refresh token adopts Claude Code's session
        {
          let ccRefreshes = 0;
          let tokenCalls = 0;
          const dead = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              tokenCalls++;
              const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (b.grant_type === "refresh_token" && b.refresh_token === "dead-rt") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }));
                return;
              }
              ccRefreshes++;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ access_token: "recovered-at", refresh_token: "cc-rt-2", expires_in: 3600, scope: "user:inference" }));
            });
          });
          await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
          const prevTokenUrl = process.env.ANTHROPIC_TOKEN_URL;
          const prevCred = process.env.CLAUDE_CREDENTIALS_FILE;
          try {
            process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${(dead.address() as any).port}/v1/oauth/token`;
            const home = mkTmp("wf-recovery-");
            const seedDead = path.join(home, "dead-session.json");
            fs.writeFileSync(seedDead, JSON.stringify({ claudeAiOauth: { accessToken: "old-at", refreshToken: "dead-rt", expiresAt: Date.now() - 1000, scopes: ["user:inference"] } }));
            const ccAlive = path.join(home, "cc-alive.json");
            // Claude Code's session: its access token is expired too, but its
            // refresh token still works — exactly the "run CC once" state
            fs.writeFileSync(ccAlive, JSON.stringify({ claudeAiOauth: { accessToken: "cc-stale-at", refreshToken: "cc-rt", expiresAt: Date.now() - 1000, scopes: ["user:inference"] } }));

            const oauth3 = new ClaudeOAuth(path.join(home, "tokens3.json"));
            oauth3.importFromClaudeCode(seedDead); // a dead session, manually seeded
            process.env.CLAUDE_CREDENTIALS_FILE = ccAlive;
            const got = await oauth3.getAccessToken();
            check(got === "recovered-at", "a rejected refresh adopts Claude Code's session and refreshes it");
            check(ccRefreshes === 1, "recovery used exactly one refresh call");
            check(oauth3.signedIn, "recovery keeps the session signed in");
            const again = await oauth3.getAccessToken();
            check(again === "recovered-at" && ccRefreshes === 1, "the recovered token is used without further refreshes");

            // nothing left to recover from: Claude Code's refresh is dead too
            const oauth4 = new ClaudeOAuth(path.join(home, "tokens4.json"));
            oauth4.importFromClaudeCode(seedDead);
            process.env.CLAUDE_CREDENTIALS_FILE = seedDead; // CC holds the same dead token
            const before = tokenCalls;
            let msg = "";
            try {
              await oauth4.getAccessToken();
            } catch (e) {
              msg = (e as Error).message;
            }
            check(/npm run import/.test(msg), `unrecoverable refresh tells the user what to run (${msg})`);
            check(tokenCalls === before + 2, "doomed refresh + one recovery attempt, then it gives up");
            await oauth4.getAccessToken().catch(() => {});
            check(tokenCalls === before + 3, "recovery stays exhausted — later calls only pay the doomed refresh");
          } finally {
            process.env.ANTHROPIC_TOKEN_URL = prevTokenUrl;
            if (prevCred === undefined) delete process.env.CLAUDE_CREDENTIALS_FILE;
            else process.env.CLAUDE_CREDENTIALS_FILE = prevCred;
            dead.close();
          }
        }

        server.close();
        console.log("ALL TESTS PASSED ✓ (exchange, refresh, header injection, import, refresh-token recovery)");
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
