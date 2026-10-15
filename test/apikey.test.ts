/**
 * Unit test: API key resolution (env -> saved file -> generated) and the
 * startup banner text.
 *
 *   npx tsx test/apikey.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-key-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.WRONGFORGE_HOME = path.join(tmp, "home");

const { resolveApiKey, maskKey, apiKeyFile, MIN_KEY_LENGTH } = await import("../src/apikey.js");
const { renderBanner } = await import("../src/banner.js");

// 1. nothing configured -> generated, saved
const first = resolveApiKey({} as NodeJS.ProcessEnv);
assert(first.source === "generated", "first start generates a key");
assert(/^wf_[A-Za-z0-9_-]{32}$/.test(first.key), "key format wf_ + 32 url-safe chars");
assert(first.key.length >= MIN_KEY_LENGTH, "generated key is long enough");
assert(fs.readFileSync(apiKeyFile(), "utf8").trim() === first.key, "key saved to file");

// 2. next start -> same key from the file
const second = resolveApiKey({} as NodeJS.ProcessEnv);
assert(second.source === "file" && second.key === first.key, "key is stable across restarts");

// 3. env wins and is not written anywhere
const envKey = "an-env-key-with-enough-length";
const fromEnv = resolveApiKey({ AGENT_API_KEY: envKey } as NodeJS.ProcessEnv);
assert(fromEnv.source === "env" && fromEnv.key === envKey, "env var takes precedence");
assert(fs.readFileSync(apiKeyFile(), "utf8").trim() === first.key, "env key does not overwrite the saved key");

// 4. too-short env key is an error with a helpful message
let msg = "";
try {
  resolveApiKey({ AGENT_API_KEY: "short" } as NodeJS.ProcessEnv);
} catch (e) {
  msg = (e as Error).message;
}
assert(msg.includes("too short") && msg.includes("generate"), "short env key -> clear error");

// 5. corrupted/short file -> regenerated
fs.writeFileSync(apiKeyFile(), "x\n");
const regen = resolveApiKey({} as NodeJS.ProcessEnv);
assert(regen.source === "generated" && regen.key !== first.key, "unusable stored key is replaced");

// 6. mask
assert(maskKey("wf_abcdefghijklmnop").startsWith("wf_ab") && !maskKey("wf_abcdefghijklmnop").includes("fghijklm"), "mask hides the middle");

// 7. banner
const base = {
  version: "9.9.9", host: "127.0.0.1", port: 8787, signedIn: true,
  model: "claude-sonnet-5-5", dataDir: "/data", promptFiles: ["wstack-tools.md"],
};
const gen = renderBanner({ ...base, key: { key: "wf_SECRETSECRETSECRETSECRETSECRET12", source: "generated", file: "/data/api-key" } });
assert(gen.includes("WrongForge v9.9.9"), "banner shows name+version");
assert(gen.includes("What this is") && gen.includes("WrongStack"), "banner explains the tool");
assert(gen.includes("wf_SECRETSECRETSECRETSECRETSECRET12"), "generated key shown in full");
assert(gen.includes("NEW key generated"), "banner says the key is new");
assert(gen.includes("Bearer wf_SECRETSECRETSECRETSECRETSECRET12"), "example uses the real key");
assert(gen.includes("signed in") && !gen.includes("NOT signed in"), "signed-in state");
assert(gen.includes("wstack-tools.md"), "lists tool guides");
assert(!gen.includes("\x1b["), "no ANSI codes when color is off");

const env = renderBanner({ ...base, signedIn: false, key: { key: "my-very-secret-env-key-1234", source: "env" } });
assert(!env.includes("my-very-secret-env-key-1234"), "env key is NOT printed in full");
assert(env.includes("AGENT_API_KEY") && env.includes("Bearer <key>"), "env key masked + placeholder in example");
assert(env.includes("NOT signed in") && env.includes("npm run import"), "tells how to sign in");

const open = renderBanner({ ...base, host: "0.0.0.0", key: { key: "wf_x".repeat(8), source: "file", file: "/f" } });
assert(open.includes("not loopback"), "warns when not bound to loopback");
assert(renderBanner({ ...base, key: first }, true).includes("\x1b["), "colors when enabled");

console.log("APIKEY + BANNER TESTS PASSED ✓ (generate, persist, env, errors, banner text)");
