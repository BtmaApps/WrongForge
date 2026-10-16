/**
 * Human-readable startup banner for `npm run serve`: what this tool is, where
 * it listens, which key to use and how to try it.
 */

import * as os from "node:os";
import { maskKey, type ResolvedKey } from "./apikey.js";

export interface BannerInfo {
  version: string;
  host: string;
  port: number;
  key: ResolvedKey;
  signedIn: boolean;
  model: string;
  dataDir: string;
  logDir?: string;
  maxConcurrency?: number;
  /** Names of loaded guide files from the prompts directory. */
  promptFiles?: string[];
  /** Workdir used when a task names none; null/undefined = every task must name one. */
  defaultWorkdir?: string | null;
  /** Number of configured MCP servers. */
  mcpServers?: number;
  /** Tasks from the previous run that were marked failed(server_restarted). */
  recoveredTasks?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function renderBanner(i: BannerInfo, color = false): string {
  const c = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s: string): string => c("1", s);
  const dim = (s: string): string => c("2", s);
  const cyan = (s: string): string => c("36", s);
  const green = (s: string): string => c("32", s);
  const yellow = (s: string): string => c("33", s);
  const red = (s: string): string => c("31", s);

  const url = `http://${i.host.includes(":") ? `[${i.host}]` : i.host}:${i.port}`;
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "the current user";
    }
  })();

  const keyLine =
    i.key.source === "env"
      ? `${bold(maskKey(i.key.key))}  ${dim("(from AGENT_API_KEY)")}`
      : bold(green(i.key.key));
  const keyNote =
    i.key.source === "generated"
      ? `${yellow("NEW")} key generated and saved to ${i.key.file}\n  It stays the same on every restart — copy it into WrongStack's config now.`
      : i.key.source === "file"
        ? `${dim(`stored in ${i.key.file} (reused from an earlier start)`)}`
        : dim("full value is the AGENT_API_KEY you set");

  const lines: string[] = [];
  const title = ` WrongForge v${i.version} `;
  const sub = " Autonomous worker agent for WrongStack ";
  const w = Math.max(title.length, sub.length) + 2;
  lines.push(cyan(`╭${"─".repeat(w)}╮`));
  lines.push(cyan("│") + bold(title.padEnd(w)) + cyan("│"));
  lines.push(cyan("│") + sub.padEnd(w) + cyan("│"));
  lines.push(cyan(`╰${"─".repeat(w)}╯`));
  lines.push("");
  lines.push(bold("What this is"));
  lines.push("  A standalone agent that is signed in with your Claude account and carries out");
  lines.push("  tasks sent to it over HTTP. It works on THIS machine with its own tools");
  lines.push("  (read / write / edit / glob / grep / bash / web fetch) and can drive the");
  lines.push("  WrongStack CLI through bash. While a task runs it reports to the caller:");
  lines.push("  started -> progress -> heartbeat -> finished (or failed / cancelled), and");
  lines.push("  writes everything to JSONL logs. Conversations are kept as resumable sessions.");
  lines.push("");
  lines.push(`${bold("Listening")}   ${cyan(url)}`);
  lines.push(
    `${bold("Account")}     ${i.signedIn ? green("signed in ✓") : red("NOT signed in") + " — run:  npm run import   (or npm run login)"}`,
  );
  lines.push(`${bold("Model")}       ${i.model}`);
  lines.push(`${bold("Data")}        ${i.dataDir}`);
  if (i.logDir) lines.push(`${bold("Logs")}        ${i.logDir}  ${dim("(daily JSONL, gzip + cleanup automatic)")}`);
  if (i.maxConcurrency) lines.push(`${bold("Concurrency")} ${i.maxConcurrency} task(s) at a time, the rest wait in a queue`);
  if (i.defaultWorkdir !== undefined) {
    lines.push(
      `${bold("Workdir")}     ${i.defaultWorkdir ? i.defaultWorkdir : dim('every task must name its "workdir"')}`,
    );
  }
  if (i.mcpServers !== undefined) {
    lines.push(
      `${bold("MCP")}         ${i.mcpServers ? `${i.mcpServers} server(s) configured` : dim("none yet")}  ${dim("(npm run mcp -- help)")}`,
    );
  }
  if (i.promptFiles) {
    lines.push(
      `${bold("Tool guides")} ${i.promptFiles.length ? i.promptFiles.join(", ") : dim("none yet (drop *.md files into prompts/)")}`,
    );
  }
  if (i.recoveredTasks) {
    lines.push(yellow(`${bold("Recovered")}    ${i.recoveredTasks} task(s) from the previous run were marked failed (server_restarted)`));
  }
  lines.push("");
  lines.push(bold("API key") + dim("   send as   Authorization: Bearer <key>"));
  lines.push(`  ${keyLine}`);
  lines.push(`  ${keyNote}`);
  lines.push("");
  // the real key is only inlined when it is already shown in full above
  const keyInExample = i.key.source === "env" ? "<key>" : i.key.key;
  lines.push(bold("Try it"));
  lines.push(`  curl ${url}/health`);
  lines.push(`  curl ${url}/v1/tasks -H "Authorization: Bearer ${keyInExample}" -H "Content-Type: application/json" \\`);
  lines.push(`       -d '{"prompt":"say hello","workdir":"${i.defaultWorkdir ?? "<a directory>"}","wait":true}'`);
  lines.push(dim("  Full protocol: docs/TASKS-API.md   Integration guide: docs/INTEGRATION.md"));
  lines.push("");
  if (!LOOPBACK.has(i.host)) {
    lines.push(red(`⚠ Listening on ${i.host}, not loopback: put TLS and a firewall in front of it.`));
  }
  lines.push(yellow(`⚠ Whoever has the key can run commands as ${user} on this machine. Keep it secret.`));
  lines.push(dim("Experimental software, provided as-is — no warranty, no liability (MIT)."));
  lines.push("");
  lines.push(dim("Ctrl+C to stop (running tasks are marked interrupted and can be re-sent)."));
  return lines.join("\n");
}

export function printBanner(i: BannerInfo): void {
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  console.log("\n" + renderBanner(i, color) + "\n");
}
