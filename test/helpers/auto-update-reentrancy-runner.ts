/**
 * F963 — child runner for the auto-update poll re-entrancy proof/verifier.
 *
 * `startEnvServer()`'s `maybeAutoUpdate()` (the WRONGFORGE_AUTO_UPDATE idle
 * poller) has no "already preparing" guard: every `setInterval` tick calls
 * `prepareUpdate()` unconditionally once an update is known and the server
 * is idle. `prepareUpdate()` itself does a real network download that can
 * easily outlast the poll interval on a slow connection — this runner
 * controls that timing directly by making the release lookup (the first
 * thing `prepareUpdate()` awaits) resolve slowly, and records the exact
 * start/end time of every call so the driver can compute the true maximum
 * overlap by a sweep over timestamps (no shared counter is ever reset while
 * a call might still be in flight, which would itself be a race).
 *
 * The release's asset URL still points at an unreachable port (same trick
 * as test/helpers/auto-update-runner.ts) so prepareUpdate() always fails
 * after the artificial delay and this process never reaches installUpdate()
 * (which would process.exit() it).
 *
 * Controlled by an env var so the same runner proves both sides:
 *   F963_DELAY_MS unset/0  -> fast resolution (the CONTROL: no overlap possible)
 *   F963_DELAY_MS=<n>      -> n-ms artificial delay (the FAILING CASE on
 *                             unmodified code; must stay single-flight once fixed)
 */
import { lastUpdateCheck, setIsCompiledBinaryForTest, setLatestReleaseForTest, type ReleaseInfo } from "../../src/update.js";
import { ClaudeOAuth } from "../../src/oauth.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Timestamps must be monotonic AND finer than a millisecond: with Date.now()
// a call's end and the next poller call's start can land in the same
// millisecond under CI load, and the sweep-line's starts-before-ends
// tie-break then counts the two half-open intervals as overlapping
// (F1503: a false maxConcurrent=2 on correct single-flight code).
const now = (): bigint => process.hrtime.bigint();

const presignIn = new ClaudeOAuth(process.env.CLAUDE_TOKEN_STORE);
await presignIn.exchangeCode("code", "verifier", "https://console.anthropic.com/oauth/code/callback", "user:inference user:profile");

const delayMs = Number(process.env.F963_DELAY_MS ?? 0);

// Append-only call log (start/end timestamps) — never reset, so there is no
// window where a reset can race an already-in-flight call (that race lives
// in a naive "zero a shared counter" approach, not in the thing being
// tested). The driver only looks at calls that started after the marker
// below, so the startup announceUpdate() check is excluded without ever
// mutating shared state concurrently with it.
const calls: { start: bigint; end: bigint }[] = [];
const newer: ReleaseInfo = {
  current: "0.0.1",
  latest: "99.0.0",
  url: "https://example.invalid/releases/99.0.0",
  notes: "",
  asset: { name: "fake-asset", url: "http://127.0.0.1:1/nope", digest: `sha256:${"0".repeat(64)}`, size: 10 },
};
setIsCompiledBinaryForTest(true);
setLatestReleaseForTest(async () => {
  const rec = { start: now(), end: -1n };
  calls.push(rec);
  if (delayMs > 0) await sleep(delayMs);
  rec.end = now();
  return newer;
});

const { startEnvServer } = await import("../../src/server.js");
const started = await startEnvServer();

// wait for the startup check (announceUpdate) to populate lastUpdateCheck()
const t0 = Date.now();
while (!lastUpdateCheck() && Date.now() - t0 < 5000) await sleep(25);
if (!lastUpdateCheck()) throw new Error("startup update check never completed");
const idlePollMarker = now(); // calls starting at/after this are the idle poller's, not the startup check's

// WRONGFORGE_AUTO_UPDATE_POLL_MS (set by the caller, short) ticks repeatedly
// while the server sits idle; wait long enough for several ticks to fire
// whether or not the delayed call has resolved yet.
const pollMs = Number(process.env.WRONGFORGE_AUTO_UPDATE_POLL_MS ?? 50);
await sleep(Math.max(pollMs * 6, delayMs + pollMs * 2));
// let the very last in-flight call (if any) reach its own `rec.end` write
// before shutdown tears the server down, so no call is left with end=-1.
await sleep(delayMs + 50);

await started.shutdown();

// Sweep-line: compute the maximum number of [start,end) intervals that were
// simultaneously open, restricted to calls attributable to the idle poller.
const relevant = calls.filter((c) => c.start >= idlePollMarker);
type Edge = [time: bigint, delta: number];
const edges: Edge[] = [];
for (const c of relevant) {
  edges.push([c.start, 1]);
  edges.push([c.end === -1n ? now() : c.end, -1]);
}
edges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : b[1] - a[1])); // starts before ends at the same instant, so a near-instant call still registers
let running = 0;
let maxConcurrent = 0;
for (const [, delta] of edges) {
  running += delta;
  maxConcurrent = Math.max(maxConcurrent, running);
}

console.log(JSON.stringify({ totalCalls: relevant.length, maxConcurrent }));
setTimeout(() => process.exit(0), 1_000).unref();
