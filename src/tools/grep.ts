import { tool } from "../tool.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_WALK_FILES, compileGlob, walkFiles } from "./glob-utils.js";
import { MAX_FILE_BYTES, errText, isBinary, resolvePath, splitLines } from "./util.js";

/** Trimmed line, cut to 300 chars around the first match for minified code. */
function fmtLine(line: string, re: RegExp): string {
  const t = line.trim();
  if (t.length <= 300) return t;
  const m = re.exec(line);
  const from = Math.max(0, (m?.index ?? 0) - 100);
  return (from > 0 ? "…" : "") + line.slice(from, from + 300).trim() + "…";
}

export const grep = tool({
  description:
    "Searches file contents with a JavaScript regular expression, recursively " +
    "from the given path (default .), optionally filtered by a glob. Modes: " +
    "`content` (default; lines as `path:line: text`, context lines as " +
    "`path-line- text`), `files_with_matches` (just paths) and `count` " +
    "(`path:n`). Ignores .git, node_modules, binary files and files over 2 MB. " +
    "Use it to locate code before reading or editing it.",
  inputSchema: z.object({
    pattern: z.string().min(1).describe("JavaScript regular expression to search for"),
    path: z.string().optional().describe("File or directory to search (default .)"),
    glob: z.string().optional().describe("Only search files matching this glob, e.g. *.ts"),
    ignore_case: z.boolean().optional().describe("Case-insensitive (default false)"),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .optional()
      .describe("What to return (default content)"),
    context: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Lines of context before/after each match (content mode only)"),
    max_results: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe("Max matches (content) or files (other modes); default 100"),
  }),
  execute: async ({ pattern, path: p, glob, ignore_case, output_mode, context, max_results }) => {
    try {
      const root = resolvePath(p ?? ".");
      const st = await fs.stat(root).catch(() => null);
      if (!st) return { ok: false, error: `path not found: ${root}` };
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (e) {
        return { ok: false, error: `invalid regex: ${(e as Error).message}` };
      }
      const matcher = glob ? compileGlob(glob) : null;
      const isFile = st.isFile();
      const walked = isFile ? { files: [root], capped: false } : await walkFiles(root);
      const base = isFile ? path.dirname(root) : root;
      const mode = output_mode ?? "content";
      const ctx = mode === "content" ? (context ?? 0) : 0;
      const limit = max_results ?? 100;

      const results: string[] = [];
      let matchCount = 0; // matching lines (content) or files (other modes)
      let filesSearched = 0;
      let skippedLarge = 0;
      let truncated = false;

      for (const f of walked.files) {
        if (truncated) break;
        const rel = path.relative(base, f).split(path.sep).join("/");
        if (matcher && !matcher(rel)) continue;
        const fst = await fs.stat(f).catch(() => null);
        if (!fst) continue;
        if (fst.size > MAX_FILE_BYTES) {
          skippedLarge++;
          continue;
        }
        let buf: Buffer;
        try {
          buf = await fs.readFile(f);
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        filesSearched++;
        const lines = splitLines(buf.toString("utf8"));

        if (mode !== "content") {
          let n = 0;
          for (const line of lines) {
            if (re.test(line)) {
              n++;
              if (mode === "files_with_matches") break;
            }
          }
          if (n === 0) continue;
          if (matchCount >= limit) {
            truncated = true;
            break;
          }
          matchCount++;
          results.push(mode === "count" ? `${rel}:${n}` : rel);
          continue;
        }

        const hits: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (matchCount + hits.length >= limit) {
            truncated = true;
            break;
          }
          hits.push(i);
        }
        if (hits.length === 0) continue;
        matchCount += hits.length;

        // merge overlapping context windows into contiguous ranges
        const ranges: [number, number][] = [];
        for (const i of hits) {
          const s = Math.max(0, i - ctx);
          const e = Math.min(lines.length - 1, i + ctx);
          const last = ranges[ranges.length - 1];
          if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
          else ranges.push([s, e]);
        }
        const hitSet = new Set(hits);
        for (const [s, e] of ranges) {
          if (ctx > 0 && results.length > 0) results.push("--");
          for (let i = s; i <= e; i++) {
            results.push(
              hitSet.has(i)
                ? `${rel}:${i + 1}: ${fmtLine(lines[i], re)}`
                : `${rel}-${i + 1}- ${fmtLine(lines[i], re)}`,
            );
          }
        }
      }

      const notes: string[] = [];
      if (walked.capped) notes.push(`only the first ${MAX_WALK_FILES} files were scanned`);
      if (skippedLarge) notes.push(`${skippedLarge} file(s) over 2 MB skipped`);
      return {
        ok: true,
        mode,
        matches: results,
        matchCount,
        filesSearched,
        truncated,
        ...(notes.length && { note: notes.join("; ") }),
      };
    } catch (e) {
      return { ok: false, error: errText(e, p) };
    }
  },
});
