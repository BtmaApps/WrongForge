/**
 * WrongForge — CLI entry point.
 *
 *   npm run login            # browser + paste-the-code flow
 *   npm run status           # session status
 *   npm run url              # just print an authorize URL
 *   npm run models           # live model list (requires login)
 *   npm start                # chat REPL
 *
 * REPL commands: /exit /reset /status /model <id> /effort [lvl] /models /tools /help
 */

import * as readline from "node:readline";
import type { AgentMessage } from "./messages.js";
import { ClaudeOAuth } from "./oauth.js";
import { configHelp } from "./config.js";
import { createClaudeClient } from "./provider.js";
import { agentTools } from "./tools/index.js";
import { runAgentTurn, DEFAULT_MODEL, KNOWN_MODELS } from "./agent.js";
import {
  defaultEffort,
  effortSupport,
  isEffortSetting,
  resolveEffort,
  sessionEffort,
  setSessionEffort,
} from "./effort.js";
import { fetchModelList } from "./models.js";
import { fetchPlanUsage, usageLine } from "./usage.js";
import * as crypto from "node:crypto";

const HELP = `
Commands:
  /help            show this help
  /status          session and model status
  /usage           plan limits: 5h session window, weekly limit, extra usage
  /model <id>      switch model (e.g. claude-sonnet-5-5, claude-opus-5-5)
  /effort [lvl]    show or set reasoning effort: low | medium | high | off
  /models          live model list (requires a signed-in session)
  /reset           clear the conversation history
  /tools           list available tools
  /exit            quit
Everything else is sent to the model.
`;

/** What effort currently means for a model, accounting for its support. */
const effortLine = (model: string): string => {
  const setting = sessionEffort() ?? defaultEffort();
  const r = resolveEffort(setting, model);
  if (setting === "off") return "off";
  if (r.unsupported) return `${setting} (model has no effort support — parameter not sent)`;
  return r.clamped ? `${setting} → ${r.effort} (clamped to model support)` : String(r.effort);
};

/** Exported for the in-process test suite (argv can be passed explicitly). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = argv;
  const cmd = args[0] ?? "chat";
  const oauth = new ClaudeOAuth(
    process.env.CLAUDE_TOKEN_STORE || undefined,
  );

  if (cmd === "url") {
    const cfg = oauth.config;
    if (!cfg) {
      console.error(configHelp());
      process.exit(1);
    }
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const url = oauth.buildAuthorizeUrl(
      challenge,
      crypto.randomBytes(24).toString("base64url"),
      cfg.redirectUri,
      cfg.scope,
    );
    console.log(url);
    return;
  }

  if (cmd === "status") {
    console.log(JSON.stringify(oauth.status(), null, 2));
    return;
  }

  if (cmd === "logout") {
    oauth.logout();
    console.log("signed out");
    return;
  }

  if (cmd === "login") {
    if (args.includes("--loopback")) {
      console.log(
        "Note: --loopback is not supported — the only redirect registered for\n" +
        "this client is https://console.anthropic.com/oauth/code/callback\n" +
        "(the server rejects loopback redirect URIs). Using the standard\n" +
        "paste-the-code flow.\n",
      );
    }
    const noBrowser = args.includes("--no-browser");
    await oauth.login({ noBrowser });
    console.log(JSON.stringify(oauth.status(), null, 2));
    return;
  }

  if (cmd === "import") {
    const fileArg = args.find((a, i) => i > 0 && !a.startsWith("-"));
    oauth.importFromClaudeCode(fileArg);
    console.log(JSON.stringify(oauth.status(), null, 2));
    return;
  }

  if (cmd === "models") {
    if (!oauth.signedIn) {
      console.log("Not signed in — known models (run `npm run login` for the live list):");
      for (const [id, desc] of Object.entries(KNOWN_MODELS)) {
        console.log(`- ${id}: ${desc}`);
      }
      return;
    }
    const res = await fetchModelList(oauth);
    if (!res.ok) {
      console.log(`Could not fetch the live list (${res.error}). Known models:`);
      for (const [id, desc] of Object.entries(KNOWN_MODELS)) {
        console.log(`- ${id}: ${desc}`);
      }
      return;
    }
    console.log(`Models available to your account (${res.models.length}):\n`);
    for (const m of res.models) {
      console.log(`- ${m.id}${m.display_name !== m.id ? `  (${m.display_name})` : ""}`);
    }
    return;
  }

  // ---- chat mode ----
  if (!oauth.signedIn) {
    console.log(
      "No session found. Either log in (`npm run login`) or reuse your\n" +
      "Claude Code session (`npm run import`):\n\n  npm run import\n",
    );
    if (cmd !== "chat") return;
  }

  let modelId = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  const history: AgentMessage[] = [];

  const client = createClaudeClient(oauth);
  console.log(`WrongForge — model: ${modelId} · effort: ${effortLine(modelId)}`);
  console.log(HELP);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[32myou>\x1b[0m ",
  });

  let busy = false;
  let turnAbort: AbortController | null = null;
  rl.prompt();

  const fmt = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

  rl.on("line", async (line: string) => {
    const text = line.trim();
    if (busy) return;
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === "/exit" || text === "/quit") {
      rl.close();
      return;
    }
    if (text === "/help") {
      console.log(HELP);
      rl.prompt();
      return;
    }
    if (text === "/status") {
      console.log(JSON.stringify({ ...oauth.status(), model: modelId, effort: effortLine(modelId) }, null, 2));
      rl.prompt();
      return;
    }
    if (text === "/usage") {
      const u = await fetchPlanUsage(oauth);
      if (!u) console.log("usage unavailable (signed in? network?)");
      else {
        console.log(usageLine(u));
        console.log(JSON.stringify({ five_hour: u.fiveHour, weekly: u.weekly, extra_usage: u.extraUsage }, null, 2));
      }
      rl.prompt();
      return;
    }
    if (text === "/reset") {
      history.length = 0;
      console.log("history cleared");
      rl.prompt();
      return;
    }
    if (text === "/tools") {
      for (const [name, t] of Object.entries(agentTools)) {
        console.log(`- ${name}: ${t.description}`);
      }
      rl.prompt();
      return;
    }
    if (text === "/models") {
      const res = await fetchModelList(oauth).catch(() => null);
      if (res?.ok) {
        console.log(`Available models (${res.models.length}):`);
        for (const m of res.models) {
          console.log(`- ${m.id}`);
        }
      } else {
        console.log("Known models:");
        for (const [id, desc] of Object.entries(KNOWN_MODELS)) {
          console.log(`- ${id}: ${desc}`);
        }
      }
      rl.prompt();
      return;
    }
    if (text.startsWith("/model ")) {
      modelId = text.slice("/model ".length).trim();
      console.log(`model: ${modelId} · effort: ${effortLine(modelId)}`);
      rl.prompt();
      return;
    }
    if (text === "/effort" || text.startsWith("/effort ")) {
      const arg = text.slice("/effort".length).trim().toLowerCase();
      if (!arg) {
        const supported = effortSupport(modelId);
        console.log(`effort: ${effortLine(modelId)}`);
        console.log(`levels: low | medium | high | off · this model supports: ${supported.length ? supported.join(", ") : "none"}`);
      } else if (isEffortSetting(arg)) {
        setSessionEffort(arg);
        console.log(`effort: ${effortLine(modelId)}`);
      } else {
        console.log('effort must be "low", "medium", "high" or "off"');
      }
      rl.prompt();
      return;
    }
    if (text.startsWith("/")) {
      console.log("unknown command — /help");
      rl.prompt();
      return;
    }

    busy = true;
    const mark = history.length; // roll back to here if the turn fails
    history.push({ role: "user", content: text });
    turnAbort = new AbortController();
    try {
      const r = await runAgentTurn(client, modelId, history, undefined, turnAbort.signal);
      if (r.finishReason === "aborted") {
        history.length = mark;
        /* c8 ignore next 2 -- needs a real Ctrl+C signal; not deliverable over pipes on Windows */
        console.log("\n\x1b[33m[interrupted — turn discarded]\x1b[0m");
      } else {
        console.log(
          `\n\x1b[2m[${r.finishReason}${r.toolCalls ? `, ${r.toolCalls} tool call(s)` : ""} · ` +
            `in ${fmt(r.usage.input_tokens)} (${fmt(r.usage.cache_read_tokens)} cached, ${fmt(r.usage.cache_write_tokens)} written) · ` +
            `out ${fmt(r.usage.output_tokens)} · context ${fmt(r.context_tokens)}]\x1b[0m`,
        );
      }
    } catch (e) {
      // drop the failed turn so the next message doesn't follow a dangling one
      history.length = mark;
      if (turnAbort.signal.aborted) {
        console.log("\n\x1b[33m[interrupted — turn discarded]\x1b[0m");
      } else {
        console.error(`\x1b[31m[error] ${(e as Error).message}\x1b[0m`);
      }
    } finally {
      turnAbort = null;
      busy = false;
      rl.prompt();
    }
  });

  // Ctrl+C: cancel the running turn; when idle, quit.
  rl.on("SIGINT", () => {
    /* c8 ignore next 5 -- SIGINT arrives only from a real terminal; not testable over pipes on Windows */
    if (turnAbort) {
      turnAbort.abort();
    } else {
      rl.close();
    }
  });

  rl.on("close", () => {
    console.log("\nbye.");
    process.exit(0);
  });
}

main()
  .then(() => {
    // natural exit (no hard process.exit) avoids the libuv close-assertion
    // noise from open TTY handles on Windows
    if (process.argv[2] && process.argv[2] !== "chat") process.exitCode = 0;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
