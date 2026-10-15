import { tool } from "../tool.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import { MAX_READ_BYTES, countOccurrences, errText, isBinary, resolvePath } from "./util.js";

const NOT_FOUND_BASE =
  "old_string not found in the file. It must match exactly, including " +
  "whitespace and indentation. Read the file again and copy the text precisely.";

/** Points at lines where old_string's first line appears, to spot whitespace slips. */
function notFoundHint(content: string, old: string): string {
  const first = old
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return NOT_FOUND_BASE;
  const lines = content.split(/\r?\n/);
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < 5; i++) {
    if (lines[i].includes(first)) hits.push(i + 1);
  }
  return hits.length
    ? `${NOT_FOUND_BASE} The first line of old_string (trimmed) does appear at line(s) ${hits.join(", ")} — check for whitespace/indentation differences.`
    : NOT_FOUND_BASE;
}

const lineOf = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length;

export const edit = tool({
  description:
    "Makes an exact string replacement in a file. old_string must match the " +
    "file content EXACTLY, including whitespace and indentation, and must be " +
    "unique in the file (include surrounding lines for context if needed). " +
    "Set replace_all only to replace every occurrence (e.g. renaming). " +
    "Strings are literal — `$&` and similar are not special. CRLF files can be " +
    "edited with LF-written old_string. Read the file first.",
  inputSchema: z.object({
    path: z.string().describe("File path to edit"),
    old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)"),
    new_string: z.string().describe("Replacement text (must differ from old_string)"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  }),
  execute: async ({ path: p, old_string, new_string, replace_all }) => {
    try {
      if (old_string === "") {
        return {
          ok: false,
          error: "old_string must not be empty (use write to create or overwrite a file)",
        };
      }
      if (old_string === new_string) {
        return { ok: false, error: "old_string and new_string are identical — nothing to change" };
      }
      const abs = resolvePath(p);
      const st = await fs.stat(abs);
      if (st.isDirectory()) return { ok: false, error: `${abs} is a directory, not a file` };
      if (st.size > MAX_READ_BYTES) {
        return { ok: false, error: "file is larger than 10 MB — edit it with bash instead" };
      }
      const raw = await fs.readFile(abs);
      if (isBinary(raw)) return { ok: false, error: "binary file — refusing to edit" };
      const content = raw.toString("utf8");

      let oldS = old_string;
      let newS = new_string;
      let count = countOccurrences(content, oldS);
      // CRLF file, LF-style old_string: retry with the file's line endings
      if (count === 0 && content.includes("\r\n") && /(^|[^\r])\n/.test(oldS)) {
        const toCrlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
        const o2 = toCrlf(oldS);
        const c2 = countOccurrences(content, o2);
        if (c2 > 0) {
          oldS = o2;
          newS = toCrlf(newS);
          count = c2;
        }
      }

      if (count === 0) return { ok: false, error: notFoundHint(content, old_string) };
      if (count > 1 && !replace_all) {
        const where: number[] = [];
        for (
          let i = content.indexOf(oldS);
          i !== -1 && where.length < 5;
          i = content.indexOf(oldS, i + oldS.length)
        ) {
          where.push(lineOf(content, i));
        }
        return {
          ok: false,
          error:
            `old_string occurs ${count} times (lines ${where.join(", ")}${count > where.length ? ", …" : ""}). ` +
            "Add surrounding lines to make it unique, or set replace_all.",
        };
      }

      const first = content.indexOf(oldS);
      // split/join and slicing treat new_string literally (String.replace
      // would expand `$&`, `$1`, `$$` inside it)
      const updated = replace_all
        ? content.split(oldS).join(newS)
        : content.slice(0, first) + newS + content.slice(first + oldS.length);
      await fs.writeFile(abs, updated, "utf8");
      return {
        ok: true,
        path: abs,
        replacements: replace_all ? count : 1,
        line: lineOf(content, first),
      };
    } catch (e) {
      return { ok: false, error: errText(e, p) };
    }
  },
});
