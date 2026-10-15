import { tool } from "../tool.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_WALK_FILES, compileGlob, walkFiles } from "./glob-utils.js";
import { errText, resolvePath } from "./util.js";

export const glob = tool({
  description:
    "Returns file paths matching a glob pattern, sorted by modification time " +
    "(newest first). Supports `**`, `*`, `?`, `[abc]`, `[!a-z]` and braces " +
    "`{ts,tsx}`. A pattern without a `/` (e.g. `*.json`) matches the file name " +
    "at any depth; with a `/` (e.g. `src/**/*.ts`) it matches the relative path. " +
    "Ignores .git, node_modules and similar directories.",
  inputSchema: z.object({
    pattern: z.string().min(1).describe("Glob pattern, e.g. src/**/*.{ts,tsx}"),
    path: z.string().optional().describe("Root directory (default .)"),
    max: z.number().int().positive().max(1000).optional().describe("Max results (default 200)"),
  }),
  execute: async ({ pattern, path: p, max }) => {
    try {
      const root = resolvePath(p ?? ".");
      const st = await fs.stat(root).catch(() => null);
      if (!st) return { ok: false, error: `path not found: ${root}` };
      if (!st.isDirectory()) return { ok: false, error: `${root} is a file — pass a directory` };
      const matcher = compileGlob(pattern);
      const walked = await walkFiles(root);
      const hits = walked.files
        .map((f) => path.relative(root, f).split(path.sep).join("/"))
        .filter(matcher);
      const withTime: { file: string; mtimeMs: number }[] = [];
      for (let i = 0; i < hits.length; i += 64) {
        const batch = await Promise.all(
          hits.slice(i, i + 64).map(async (file) => {
            const s = await fs.stat(path.join(root, file)).catch(() => null);
            return { file, mtimeMs: s?.mtimeMs ?? 0 };
          }),
        );
        withTime.push(...batch);
      }
      withTime.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
      const cap = max ?? 200;
      return {
        ok: true,
        root,
        count: withTime.length,
        truncated: withTime.length > cap,
        files: withTime.slice(0, cap).map((m) => m.file),
        ...(walked.capped && {
          note: `only the first ${MAX_WALK_FILES} files were scanned — narrow the root path`,
        }),
      };
    } catch (e) {
      return { ok: false, error: errText(e, p) };
    }
  },
});
