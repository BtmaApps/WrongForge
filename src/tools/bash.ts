import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import { runShell } from "./shell.js";
import { resolvePath } from "./util.js";
import { workingDir, extraEnv } from "../context.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export const bash = tool({
  description:
    "Runs a shell command in the working directory (or a given cwd) and returns " +
    "stdout, stderr, the exit code and the duration. Use it for builds, tests, " +
    "git and any system task; prefer the dedicated read/edit/glob/grep tools for " +
    "file work. Commands run non-interactively (stdin is closed), so use " +
    "non-interactive flags (e.g. `git --no-pager`, `npm ci`, `-y`). Long output is " +
    "shortened, keeping the beginning and the end. On timeout the whole process " +
    "tree is killed and `timedOut` is true — raise timeout_ms for slow commands. " +
    "Ask the user before destructive or hard-to-reverse commands.",
  inputSchema: z.object({
    command: z.string().min(1).describe("The shell command to run"),
    cwd: z.string().optional().describe("Working directory (default: current)"),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe("Timeout in ms (default 30000, max 600000)"),
    description: z
      .string()
      .optional()
      .describe("Short description of what this command does (context only)"),
  }),
  execute: async ({ command, cwd, timeout_ms }, options) => {
    const dir = cwd ? resolvePath(cwd) : workingDir();
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) {
      return { ok: false, exitCode: null, error: `cwd is not an existing directory: ${dir}` };
    }
    const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const r = await runShell(command, dir, timeout, options?.abortSignal, extraEnv());
    if (r.spawnError) {
      return { ok: false, exitCode: null, error: `failed to start shell: ${r.spawnError}` };
    }
    return {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      durationMs: r.durationMs,
      ...(r.timedOut && {
        timedOut: true,
        note: `killed after ${timeout} ms timeout; raise timeout_ms if the command needs longer`,
      }),
      ...(r.signal && !r.timedOut && { signal: r.signal }),
    };
  },
});
