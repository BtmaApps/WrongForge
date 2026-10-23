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

// --------------------------------------------------------- API tool schemas

type JsonSchema = Record<string, unknown>;

const isSchema = (v: unknown): v is JsonSchema =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const omit = (s: JsonSchema, keys: string[]): JsonSchema => {
  const c = { ...s };
  for (const k of keys) delete c[k];
  return c;
};

/**
 * Flattens a tool input schema into the one shape /v1/messages accepts: a
 * plain object, with NO oneOf/allOf/anyOf at the top level (the API answers
 * "input_schema does not support oneOf, allOf, or anyOf at the top level").
 * Orchestrator/MCP tools arrive with whatever the other side declared, so
 * the agent normalizes instead of dropping the tool:
 *
 *   allOf       -> merged: union of properties, union of required
 *   oneOf/anyOf -> merged into a PERMISSIVE union: union of properties, a
 *                  field stays required only when EVERY branch requires it
 *                  (the far side validates the call anyway — the schema's
 *                  only job here is to teach the model what it may send)
 *   anything that is still not an object (a bare string/number schema)
 *              -> an empty object schema, so the tool stays callable
 *
 * Compositional keywords NESTED inside properties are left untouched: the
 * API accepts those, and rewriting them would lose information.
 */
export function toApiInputSchema(raw: unknown): { type: "object" } & JsonSchema {
  const flat = flattenObjectSchema(raw, 0);
  if (flat) return flat;
  // not representable as an object schema — keep the tool callable, keep its description
  const description = isSchema(raw) && typeof raw.description === "string" ? { description: raw.description } : {};
  return { type: "object", properties: {}, ...description };
}

function flattenObjectSchema(raw: unknown, depth: number): ({ type: "object" } & JsonSchema) | null {
  if (!isSchema(raw) || depth > 4) return null;
  let s = raw;

  // resolve allOf first (a schema may stack allOf + oneOf)
  if (Array.isArray(s.allOf)) {
    const parts = (s.allOf as unknown[])
      .map((b) => flattenObjectSchema(b, depth + 1))
      .filter((b): b is { type: "object" } & JsonSchema => b !== null);
    const head = omit(s, ["allOf"]);
    s = parts.length ? mergeObjectSchemas([head, ...parts], true) : head;
  }

  const union = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (union) {
    const branches = union
      .map((b) => flattenObjectSchema(b, depth + 1))
      .filter((b): b is { type: "object" } & JsonSchema => b !== null);
    const head = omit(s, ["oneOf", "anyOf"]);
    if (branches.length) {
      const merged = mergeObjectSchemas(branches, false);
      // the head is not an alternative — it applies to EVERY branch, so its
      // properties merge in and its required fields are ADDED on top of the
      // branch intersection
      if (isSchema(head.properties)) Object.assign(merged.properties as JsonSchema, head.properties);
      if (typeof head.description === "string" && merged.description === undefined) merged.description = head.description;
      const headReq = Array.isArray(head.required) && head.required.every((r) => typeof r === "string") ? (head.required as string[]) : [];
      const req = [...new Set([...((merged.required as string[] | undefined) ?? []), ...headReq])];
      if (req.length) merged.required = req;
      else delete merged.required;
      s = merged;
    } else {
      // no representable branch: the head alone must carry the schema
      s = { ...head, type: "object", properties: isSchema(head.properties) ? head.properties : {} };
    }
  }

  if (s.type === "object") {
    const clean = omit(s, ["oneOf", "anyOf", "allOf"]); // safety: never leak these upward
    return { ...clean, type: "object" as const, properties: isSchema(s.properties) ? s.properties : {} };
  }
  if (s.type === undefined && isSchema(s.properties)) {
    return { ...omit(s, ["type"]), type: "object", properties: s.properties };
  }
  return null; // a non-object schema cannot describe a tool input for this API
}

/**
 * Merges object schemas into one. `strict` (allOf): required = union.
 * Permissive (oneOf/anyOf): required = only what EVERY schema still demands;
 * a single schema without `required` (or none of them) drops it entirely.
 * `$defs` merge by key; `additionalProperties` survives only by unanimous
 * agreement; the FIRST schema's description wins (it is the outermost).
 */
function mergeObjectSchemas(parts: JsonSchema[], strict: boolean): { type: "object" } & JsonSchema {
  const properties: JsonSchema = {};
  let required = new Set<string>();
  let seenRequired = false;
  const defs: JsonSchema = {};
  let additional: unknown;
  let additionalAgrees = true;
  let description: unknown;

  for (const p of parts) {
    if (isSchema(p.properties)) Object.assign(properties, p.properties);
    // A branch with no `required` array demands nothing — treated as `[]`
    // uniformly (not a special case) so it still counts as "a branch was
    // seen" on the FIRST pass. Folding it in only when `seenRequired` was
    // already true (the previous shape) silently dropped a no-required
    // FIRST branch's "demands nothing" signal entirely, letting a later
    // branch's own required fields survive into the union even though the
    // first branch never required them (set intersection must not depend
    // on array order).
    const req = Array.isArray(p.required) && p.required.every((r) => typeof r === "string") ? (p.required as string[]) : [];
    if (!seenRequired) {
      required = new Set(req);
      seenRequired = true;
    } else if (strict) {
      for (const r of req) required.add(r);
    } else {
      // permissive: a field only stays required when EVERY alternative
      // requires it — intersecting with an empty `req` always empties this.
      required = new Set([...required].filter((r) => req.includes(r)));
    }
    for (const key of ["$defs", "definitions"] as const) {
      if (isSchema(p[key])) Object.assign(defs, p[key] as JsonSchema);
    }
    if ("additionalProperties" in p) {
      if (additional === undefined && !additionalAgrees) {
        /* already disagreed — stay dropped */
      } else if (additional === undefined) {
        additional = p.additionalProperties;
      } else if (additional !== p.additionalProperties) {
        additionalAgrees = false;
        additional = undefined;
      }
    }
    if (description === undefined && typeof p.description === "string") description = p.description;
  }

  const out: { type: "object" } & JsonSchema = { type: "object", properties };
  if (seenRequired && required.size > 0) out.required = [...required];
  if (Object.keys(defs).length) out.$defs = defs;
  if (additional !== undefined && additionalAgrees) out.additionalProperties = additional;
  if (description !== undefined) out.description = description;
  return out;
}
