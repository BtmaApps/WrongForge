/**
 * Shell runner for the bash tool: spawn with captured head+tail output,
 * timeout, and process-tree kill.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { truncateMiddle } from "./util.js";

const IS_WIN = process.platform === "win32";
const CAPTURE_PART_BYTES = 64 * 1024;

/** Keeps the first and last 64 KB of a stream, however much is written. */
class OutputCapture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headLen < CAPTURE_PART_BYTES) {
      const take = chunk.subarray(0, CAPTURE_PART_BYTES - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length > 0) {
      this.tail = Buffer.concat([this.tail, chunk]);
      if (this.tail.length > CAPTURE_PART_BYTES) {
        this.tail = this.tail.subarray(this.tail.length - CAPTURE_PART_BYTES);
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = this.tail.toString("utf8");
    const omitted = this.total - this.headLen - this.tail.length;
    const joined = omitted > 0 ? `${head}\n…[${omitted} bytes omitted]…\n${tail}` : head + tail;
    return truncateMiddle(joined);
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (IS_WIN) {
    // child.kill() on Windows only ends the shell, not what it started
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // whole process group
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export interface ShellResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  spawnError?: string;
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  env?: Record<string, string>,
): Promise<ShellResult> {
  return new Promise((settle) => {
    const started = Date.now();
    const out = new OutputCapture();
    const err = new OutputCapture();
    let timedOut = false;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;

    const child = spawn(command, {
      shell: true,
      cwd,
      env: env && Object.keys(env).length ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      detached: !IS_WIN, // own process group so the tree can be killed
      stdio: ["ignore", "pipe", "pipe"], // stdin closed: prompts can't hang
    });

    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      abortSignal?.removeEventListener("abort", onAbort);
      settle({
        exitCode,
        signal,
        timedOut,
        stdout: out.text(),
        stderr: err.text(),
        durationMs: Date.now() - started,
        spawnError,
      });
    };

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, signal) => finish(code, signal));

    // user interrupt (Ctrl+C in the REPL): kill the tree, same as a timeout
    function onAbort(): void {
      killTree(child);
      grace = setTimeout(() => finish(null, "SIGKILL"), 2_000);
    }
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // if a grandchild keeps the pipes open, don't wait for "close" forever
      grace = setTimeout(() => finish(null, "SIGKILL"), 2_000);
    }, timeoutMs);
  });
}
