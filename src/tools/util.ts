/**
 * Helpers shared by several tools: limits, path resolution, text/binary
 * sniffing and error formatting.
 */

import * as os from "node:os";
import * as path from "node:path";
import { workingDir } from "../context.js";

export const MAX_OUTPUT = 20_000; // chars returned per bash stream
export const MAX_READ_BYTES = 10 * 1024 * 1024; // read/edit refuse bigger files
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // grep skips bigger files

/**
 * Cuts `s` to roughly `max` chars keeping the beginning AND the end. For
 * command output the end matters most (errors, summaries), so a plain
 * head-only cut would throw away the useful part.
 */
export function truncateMiddle(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${omitted} chars omitted]…\n${s.slice(s.length - tail)}`;
}

/** Resolves against the cwd; a leading `~` expands to the home directory. */
export function resolvePath(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(workingDir(), p);
}

/** NUL byte in the first 8 KB — the classic "is this binary?" sniff. */
export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Splits on LF or CRLF; a trailing newline does not create a phantom line. */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Turns a Node fs error into a message the model can act on. */
export function errText(e: unknown, p?: string): string {
  const err = e as NodeJS.ErrnoException;
  const target = p ?? err.path ?? "";
  switch (err.code) {
    case "ENOENT":
      return `no such file or directory: ${target}`;
    case "ENOTDIR":
      return `a path component is not a directory: ${target}`;
    case "EISDIR":
      return `is a directory: ${target}`;
    case "EACCES":
    case "EPERM":
      return `permission denied: ${target}`;
    default:
      return err.message ?? String(e);
  }
}

export function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
