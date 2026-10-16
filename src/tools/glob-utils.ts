/**
 * Glob matching (**, *, ?, [abc], [!a-z], {a,b}; no dependencies) and a
 * deterministic directory walker, used by the glob and grep tools.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_WALK_FILES = 20_000;

export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".venv",
  "__pycache__",
]);

/** True when a directory must not be walked. win32/macOS fold case, so a
 *  tree whose entry is named `Node_Modules` IS `node_modules` to the OS;
 *  linux paths are case-sensitive, so there the name has to match exactly. */
const isIgnoredDir = (name: string): boolean =>
  IGNORED_DIRS.has(name) ||
  ((process.platform === "win32" || process.platform === "darwin") &&
    IGNORED_DIRS.has(name.toLowerCase()));

const escapeRe = (c: string): string => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** Expands `{a,b}` groups (nested allowed). A group without a comma is literal. */
export function expandBraces(pattern: string): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        const parts = splitTopLevel(pattern.slice(start + 1, i));
        if (parts.length > 1) {
          const pre = pattern.slice(0, start);
          const post = pattern.slice(i + 1);
          return parts.flatMap((p) => expandBraces(pre + p + post));
        }
      }
    }
  }
  return [pattern];
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

function globToRegSource(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++; // "**/" also matches ""
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      let body = close === -1 ? "" : pattern.slice(i + 1, close);
      const neg = body[0] === "!" || body[0] === "^";
      if (neg) body = body.slice(1);
      if (close === -1 || body === "") {
        re += "\\[";
      } else {
        re += "[" + (neg ? "^/" : "") + body.replace(/[\\^]/g, "\\$&") + "]";
        i = close;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return re;
}

const normalizeGlob = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function globToRegExp(pattern: string): RegExp {
  const alts = expandBraces(normalizeGlob(pattern)).map(globToRegSource);
  return new RegExp("^(?:" + alts.join("|") + ")$");
}

/**
 * Builds a matcher over `/`-separated relative paths. A pattern without a
 * slash (e.g. `*.json`) matches the file name at any depth, like gitignore;
 * a pattern with a slash matches the whole relative path.
 */
export function compileGlob(pattern: string): (rel: string) => boolean {
  const alts = expandBraces(normalizeGlob(pattern)).map((a) => ({
    re: new RegExp("^" + globToRegSource(a) + "$"),
    slash: a.includes("/"),
  }));
  return (rel) => {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    return alts.some((a) => a.re.test(a.slash ? rel : base));
  };
}

export async function walkFiles(
  root: string,
  maxFiles = MAX_WALK_FILES,
): Promise<{ files: string[]; capped: boolean }> {
  const out: string[] = [];
  let capped = false;
  const rec = async (dir: string): Promise<void> => {
    if (capped) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // deterministic order, so a capped walk is at least reproducible
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (capped) return;
      if (e.isDirectory()) {
        if (!isIgnoredDir(e.name)) await rec(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (out.length >= maxFiles) {
          capped = true;
          return;
        }
        out.push(path.join(dir, e.name));
      }
    }
  };
  await rec(root);
  return { files: out, capped };
}
