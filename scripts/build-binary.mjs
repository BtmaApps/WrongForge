/**
 * Builds the single-file WrongForge executable with Bun:
 *
 *   1. webui/dist  (npm run webui:build, unless already built)
 *   2. src/embedded-webui.ts regenerated from dist + prompts/
 *   3. bun build --compile src/main.ts → release/wrongforge-<platform>-<arch>[.exe]
 *
 *   npm run build:binary            (uses the `bun` on PATH)
 *   BUN=/path/to/bun npm run ...    (explicit interpreter)
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = (cmd, args, opts = {}) => {
  console.log(`[build] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32", ...opts });
  if (r.status !== 0) {
    console.error(`[build] failed: ${cmd} exited ${r.status}`);
    process.exit(1);
  }
};

const bun = process.env.BUN || "bun";
if (spawnSync(bun, ["--version"], { shell: process.platform === "win32" }).status !== 0) {
  console.error("[build] bun not found — install it (https://bun.sh) or set BUN=<path>");
  process.exit(1);
}

if (!fs.existsSync(path.join(root, "webui", "dist", "index.html"))) {
  run("npm", ["run", "webui:build"]);
}
run("node", ["scripts/embed-assets.mjs"]);

const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const target = `bun-${os}-${process.arch}`;
const ext = process.platform === "win32" ? ".exe" : "";
const out = path.join("release", `wrongforge-${os}-${process.arch}${ext}`);
fs.mkdirSync(path.join(root, "release"), { recursive: true });
run(bun, ["build", "--compile", `--target=${target}`, "--outfile", out, "src/main.ts"]);

const full = path.join(root, out);
console.log(`\n[build] binary: ${out} (${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`[build] try:    ./${path.basename(out)} version && ./${path.basename(out)} serve`);
