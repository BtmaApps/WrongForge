/**
 * Crash-restart supervisor (WRONGFORGE_SUPERVISE=1 wrongforge serve).
 *
 * Spawns the real `serve` process as a child and restarts it whenever it
 * exits — a crash, or the respawn-free exit selfUpdate() takes when it knows
 * this supervisor owns the restart (see src/update.ts) — with capped
 * exponential backoff so a broken binary cannot spin forever. The child is
 * marked with WRONGFORGE_SUPERVISED_CHILD=1 so main.ts never recurses into a
 * second supervisor, and so the child's own auto-update (if enabled) knows
 * to leave the respawn to us.
 *
 * The supervisor restarts the child unconditionally on exit — including
 * exit(0) — because that is also what an auto-update's respawn-free exit
 * looks like; distinguishing "crashed" from "updated" is the child's job
 * (it already finished installing the new binary before exiting), not
 * ours. The ONE case that must never restart is the supervisor's own
 * intentional shutdown: SIGINT/SIGTERM is forwarded to the child first, and
 * only once the child has actually exited does the supervisor exit too —
 * without restarting.
 */

import { spawn, type ChildProcess } from "node:child_process";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** A child alive at least this long is "it worked for a while" — the next
 *  restart (if the child later dies again) starts the backoff over. */
const RESET_BACKOFF_AFTER_MS = 60_000;

export interface SupervisorOptions {
  /** Overridable for tests: what to spawn instead of process.execPath. */
  command?: string;
  /** Milliseconds to sleep between a child's exit and the next spawn (tests
   *  override this to something tiny; production uses the real backoff). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Runs forever (until the supervisor itself is told to stop): spawn → wait
 * for exit → backoff → spawn again. Resolves only once this process's own
 * shutdown is complete (SIGINT/SIGTERM received and the child has exited).
 */
export async function runSupervisor(argv: string[], opts: SupervisorOptions = {}): Promise<void> {
  const command = opts.command ?? process.execPath;
  const sleep = opts.sleep ?? defaultSleep;
  let stopping = false;
  let child: ChildProcess | null = null;

  const forward = (signal: NodeJS.Signals): void => {
    stopping = true;
    if (child) child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  let backoff = INITIAL_BACKOFF_MS;
  for (;;) {
    if (stopping) return;
    const startedAt = Date.now();
    child = spawn(command, argv, {
      stdio: "inherit",
      env: { ...process.env, WRONGFORGE_SUPERVISED_CHILD: "1" },
    });
    const code = await new Promise<number | null>((resolve) => {
      child!.on("exit", (code) => resolve(code));
      child!.on("error", () => resolve(null)); // e.g. the command does not exist
    });
    child = null;
    if (stopping) return;

    const aliveMs = Date.now() - startedAt;
    const waitMs = backoff;
    console.error(
      `[supervisor] serve exited (code ${code ?? "?"}) after ${Math.round(aliveMs / 1000)}s — restarting in ${Math.round(waitMs / 1000)}s`,
    );
    await sleep(waitMs);
    // the wait just taken used the PREVIOUS backoff; grow it for the next
    // crash unless this child had been alive long enough to call it "it was
    // working" (a brief restart loop and a once-a-week crash should not be
    // penalized the same way)
    backoff = aliveMs >= RESET_BACKOFF_AFTER_MS ? INITIAL_BACKOFF_MS : Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
