import { tool } from "../tool.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import { MAX_READ_BYTES, errText, isBinary, resolvePath, splitLines } from "./util.js";

const READ_CHAR_BUDGET = 40_000; // chars of numbered text per read call
const MAX_LINE_CHARS = 2_000; // a single line longer than this is cut

export const read = tool({
  description:
    "Reads a text file and returns it with 1-based numbered lines (cat -n style). " +
    "Returns at most 2000 lines / ~40k characters per call; when `truncated` is " +
    "true, call again with offset=nextOffset. Very long lines are cut. Fails for " +
    "directories (use ls), binary files and files over 10 MB (use grep). " +
    "Always read a file before editing it.",
  inputSchema: z.object({
    path: z.string().describe("File path (relative or absolute; ~ is expanded)"),
    offset: z.number().int().min(1).optional().describe("1-based start line"),
    limit: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe("Max lines to return (default 2000)"),
  }),
  execute: async ({ path: p, offset, limit }) => {
    try {
      const abs = resolvePath(p);
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        return { ok: false, error: `${abs} is a directory — use ls to list it` };
      }
      if (st.size > MAX_READ_BYTES) {
        const mb = (st.size / 1024 / 1024).toFixed(1);
        return {
          ok: false,
          error: `file is ${mb} MB (limit 10 MB) — use grep, or bash with head/tail, instead`,
        };
      }
      const buf = await fs.readFile(abs);
      if (isBinary(buf)) {
        return { ok: false, error: "binary file (contains NUL bytes) — not shown" };
      }
      let content = buf.toString("utf8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // BOM
      const lines = splitLines(content);
      if (lines.length === 0) {
        return {
          ok: true,
          path: abs,
          totalLines: 0,
          shownFrom: 0,
          shownTo: 0,
          truncated: false,
          content: "",
          note: "file is empty",
        };
      }
      const start = (offset ?? 1) - 1;
      if (start >= lines.length) {
        return {
          ok: false,
          error: `offset ${offset} is beyond the end of the file (${lines.length} lines)`,
        };
      }
      const cap = limit ?? 2000;
      const rows: string[] = [];
      let chars = 0;
      for (let i = start; i < lines.length && i < start + cap; i++) {
        let l = lines[i];
        if (l.length > MAX_LINE_CHARS) {
          l = `${l.slice(0, MAX_LINE_CHARS)}…[line truncated, ${lines[i].length} chars]`;
        }
        const row = String(i + 1).padStart(6) + "\t" + l;
        if (rows.length > 0 && chars + row.length > READ_CHAR_BUDGET) break;
        rows.push(row);
        chars += row.length + 1;
      }
      const shownTo = start + rows.length;
      const truncated = shownTo < lines.length;
      return {
        ok: true,
        path: abs,
        totalLines: lines.length,
        shownFrom: start + 1,
        shownTo,
        truncated,
        ...(truncated && { nextOffset: shownTo + 1 }),
        content: rows.join("\n"),
      };
    } catch (e) {
      return { ok: false, error: errText(e, p) };
    }
  },
});
