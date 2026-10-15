import { tool } from "../tool.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errText, resolvePath } from "./util.js";

const LS_MAX = 500;

export const ls = tool({
  description:
    "Lists the entries of a directory (name, type, size), directories first. " +
    "Hidden entries are included; at most 500 entries are returned (`truncated` " +
    "says if there were more). Use `glob` to find files by pattern and `grep` to " +
    "search contents.",
  inputSchema: z.object({
    path: z.string().optional().describe("Directory to list (default .)"),
  }),
  execute: async ({ path: p }) => {
    try {
      const abs = resolvePath(p ?? ".");
      const st = await fs.stat(abs);
      if (!st.isDirectory()) {
        return { ok: false, error: `${abs} is a file, not a directory — use read` };
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      entries.sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
      const shown = await Promise.all(
        entries.slice(0, LS_MAX).map(async (e) => {
          const isDir = e.isDirectory();
          const stat = isDir ? null : await fs.stat(path.join(abs, e.name)).catch(() => null);
          return {
            name: e.name,
            type: isDir ? "dir" : e.isSymbolicLink() ? "link" : "file",
            bytes: stat?.size ?? null,
          };
        }),
      );
      return {
        ok: true,
        path: abs,
        total: entries.length,
        truncated: entries.length > LS_MAX,
        entries: shown,
      };
    } catch (e) {
      return { ok: false, error: errText(e, p) };
    }
  },
});
