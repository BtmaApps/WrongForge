import { tool } from "ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errText, resolvePath } from "./util.js";

export const write = tool({
  description:
    "Writes a text file (overwrites if it exists; `created` tells which). Creates " +
    "parent directories as needed. For targeted changes to an existing file " +
    "prefer `edit`; use `write` for new files or full rewrites.",
  inputSchema: z.object({
    path: z.string().describe("File path to write"),
    content: z.string().describe("Complete file contents"),
  }),
  execute: async ({ path: p, content }) => {
    try {
      const abs = resolvePath(p);
      const existing = await fs.stat(abs).catch(() => null);
      if (existing?.isDirectory()) {
        return { ok: false, error: `${abs} is a directory, not a file` };
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return {
        ok: true,
        path: abs,
        bytes: Buffer.byteLength(content, "utf8"),
        created: !existing,
      };
    } catch (e) {
      return { ok: false, error: errText(e, p) };
    }
  },
});
