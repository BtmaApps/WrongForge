/**
 * Durable conversation sessions.
 *
 *   <dir>/<session_id>/session.json     metadata (atomic write: tmp + rename)
 *   <dir>/<session_id>/messages.jsonl   one conversation message per line, append-only
 *
 * A session is the model's conversation memory. A task that names a
 * `session_id` continues that conversation — also after a server restart.
 * Messages are appended only after a turn SUCCEEDED, so a failed / cancelled
 * task never leaves a half turn behind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "./messages.js";
import type { CacheMode } from "./cache.js";
import { gzipFile } from "./log.js";

const DAY_MS = 86_400_000;
const MAX_TASK_IDS = 200;

/** Allowed session ids: safe as a directory name, no traversal. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionMeta {
  id: string;
  created_at: string;
  updated_at: string;
  /** Successful turns (tasks) so far. */
  turns: number;
  /** Messages stored in messages.jsonl. */
  message_count: number;
  /** First prompt (truncated) — handy when listing. */
  title: string;
  /** Model used by the last turn. */
  model?: string;
  /** Workdir of the last turn. */
  workdir?: string;
  /**
   * Conversation size in tokens after the last turn (from the API's usage
   * numbers) — what the next request starts from. Undefined before the first turn.
   */
  context_tokens?: number;
  /** How many times the history was compacted (summarized). */
  compactions: number;
  last_compaction_at?: string;
  /** Set when a request failed because the context was too large; the next task compacts first. */
  needs_compaction?: boolean;
  /**
   * Prompt-cache mode locked in by this session's first turn. Anthropic
   * requires a consistent TTL ordering across the whole cached prefix — a
   * later turn's cache_control TTL must never sort "after" an earlier one
   * still embedded in history (cache.ts only ever marks the newest message,
   * it never touches older blocks). A per-task `cache` override therefore
   * only has effect on the turn that creates the session; every later turn
   * uses this locked value regardless of what it asks for. Undefined for
   * sessions created before this field existed.
   */
  cache_mode?: CacheMode;
  /** Last task that ran in this session. */
  last_task_id?: string;
  /** Most recent task ids (capped). */
  task_ids: string[];
}

export interface LoadedSession {
  meta: SessionMeta;
  messages: AgentMessage[];
}

export class SessionStore {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  static isValidId(id: unknown): id is string {
    return typeof id === "string" && SESSION_ID_RE.test(id);
  }

  private sdir(id: string): string {
    if (!SessionStore.isValidId(id)) throw new Error(`invalid session id: ${String(id)}`);
    return path.join(this.dir, id);
  }

  exists(id: string): boolean {
    return SessionStore.isValidId(id) && fs.existsSync(path.join(this.dir, id, "session.json"));
  }

  /** Creates an empty session. Throws if the id is invalid or already taken. */
  create(id: string, now = new Date()): SessionMeta {
    const d = this.sdir(id);
    if (fs.existsSync(path.join(d, "session.json"))) throw new Error(`session already exists: ${id}`);
    fs.mkdirSync(d, { recursive: true });
    const meta: SessionMeta = {
      id,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      turns: 0,
      message_count: 0,
      title: "",
      compactions: 0,
      task_ids: [],
    };
    this.writeMeta(meta);
    return meta;
  }

  /** Loads meta + messages; null if the session does not exist. */
  load(id: string): LoadedSession | null {
    if (!this.exists(id)) return null;
    const meta = this.readMeta(id);
    if (!meta) return null;
    return { meta, messages: repairTail(this.readMessages(id)) };
  }

  /** Metadata only (cheap). */
  meta(id: string): SessionMeta | null {
    return this.exists(id) ? this.readMeta(id) : null;
  }

  /**
   * Records a successful turn: appends the new messages (user prompt +
   * assistant/tool messages) and updates the metadata.
   */
  appendTurn(
    id: string,
    newMessages: AgentMessage[],
    info: { task_id: string; model: string; prompt: string; workdir?: string; context_tokens?: number; cache_mode?: CacheMode },
    now = new Date(),
  ): SessionMeta {
    const meta = this.readMeta(id);
    if (!meta) throw new Error(`no such session: ${id}`);
    if (newMessages.length) {
      const file = path.join(this.sdir(id), "messages.jsonl");
      this.truncateTornTail(file); // never append behind an unreadable record
      const lines = newMessages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      fs.appendFileSync(file, lines);
    }
    meta.message_count += newMessages.length;
    meta.turns += 1;
    meta.updated_at = now.toISOString();
    meta.model = info.model;
    if (info.workdir) meta.workdir = info.workdir;
    if (info.context_tokens) meta.context_tokens = info.context_tokens;
    // Locked by the first turn only — never overwritten afterward (see the
    // field's doc comment on SessionMeta for why a later turn can't change it).
    meta.cache_mode ??= info.cache_mode;
    meta.needs_compaction = undefined; // a turn that fit proves the context is fine again
    meta.last_task_id = info.task_id;
    meta.task_ids = [...meta.task_ids, info.task_id].slice(-MAX_TASK_IDS);
    if (!meta.title) meta.title = info.prompt.replace(/\s+/g, " ").trim().slice(0, 80);
    this.writeMeta(meta);
    return meta;
  }

  /**
   * Replaces the stored history (compaction). The previous messages are kept
   * as `messages.archive-<timestamp>.jsonl.gz` next to it — nothing is lost.
   * Crash-safe order: write the new file, archive the old, swap, update meta.
   */
  async replaceMessages(id: string, next: AgentMessage[], now = new Date()): Promise<{ archive: string; meta: SessionMeta }> {
    const meta = this.readMeta(id);
    if (!meta) throw new Error(`no such session: ${id}`);
    const dir = this.sdir(id);
    const current = path.join(dir, "messages.jsonl");
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const archivePlain = path.join(dir, `messages.archive-${stamp}.jsonl`);

    const tmp = `${current}.tmp`;
    fs.writeFileSync(tmp, next.map((m) => JSON.stringify(m)).join("\n") + (next.length ? "\n" : ""));
    if (fs.existsSync(current)) fs.copyFileSync(current, archivePlain);
    fs.renameSync(tmp, current);
    const archive = fs.existsSync(archivePlain) ? await gzipFile(archivePlain) : "";

    meta.message_count = next.length;
    meta.compactions += 1;
    meta.last_compaction_at = now.toISOString();
    meta.context_tokens = undefined; // unknown until the next request measures it
    meta.needs_compaction = undefined;
    this.writeMeta(meta);
    return { archive, meta };
  }

  /** Small metadata updates (e.g. the needs_compaction flag). */
  patchMeta(id: string, patch: Partial<Pick<SessionMeta, "needs_compaction" | "context_tokens">>): SessionMeta | null {
    const meta = this.readMeta(id);
    if (!meta) return null;
    Object.assign(meta, patch);
    this.writeMeta(meta);
    return meta;
  }

  /** All sessions, most recently updated first. */
  list(): SessionMeta[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const n of names) {
      if (!SessionStore.isValidId(n)) continue;
      const m = this.readMeta(n);
      if (m) out.push(m);
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Stored messages with simple pagination (for inspection APIs). */
  page(id: string, offset = 0, limit = 100): { total: number; messages: AgentMessage[] } | null {
    if (!this.exists(id)) return null;
    const all = repairTail(this.readMessages(id));
    return { total: all.length, messages: all.slice(offset, offset + limit) };
  }

  delete(id: string): boolean {
    if (!this.exists(id)) return false;
    fs.rmSync(this.sdir(id), { recursive: true, force: true });
    return true;
  }

  /** Deletes sessions not updated for `deleteAfterDays` days (0 = keep forever). */
  prune(deleteAfterDays: number, now = new Date(), skip: Set<string> = new Set()): string[] {
    if (deleteAfterDays <= 0) return [];
    const removed: string[] = [];
    for (const m of this.list()) {
      if (skip.has(m.id)) continue;
      if (now.getTime() - Date.parse(m.updated_at) > deleteAfterDays * DAY_MS) {
        fs.rmSync(this.sdir(m.id), { recursive: true, force: true });
        removed.push(m.id);
      }
    }
    return removed;
  }

  // ---- internals

  /**
   * Drops an incomplete trailing record left by a crash mid-append.
   *
   * `readMessages` stops at the first line that does not parse, so the readable
   * history ends at the last complete record. Appending at the physical end of
   * the file would glue the torn fragment onto the next record and hide every
   * later turn forever — truncate to the same boundary before writing.
   */
  private truncateTornTail(file: string): void {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // no history yet
    }
    if (size === 0) return;
    try {
      const fd = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] === 0x0a) return; // healthy: the file ends on a record boundary
      } finally {
        fs.closeSync(fd);
      }
      const raw = fs.readFileSync(file, "utf8");
      const nl = raw.lastIndexOf("\n");
      fs.truncateSync(file, Buffer.byteLength(nl === -1 ? "" : raw.slice(0, nl + 1)));
    } catch {
      /* leave the file alone — the append below will surface the real error */
    }
  }

  private readMeta(id: string): SessionMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.sdir(id), "session.json"), "utf8")) as SessionMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: SessionMeta): void {
    const file = path.join(this.sdir(meta.id), "session.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, file);
  }

  private readMessages(id: string): AgentMessage[] {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.sdir(id), "messages.jsonl"), "utf8");
    } catch {
      return [];
    }
    const out: AgentMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AgentMessage);
      } catch {
        break; // torn last line after a crash: ignore it and anything after
      }
    }
    return out;
  }
}

/**
 * After a crash in the middle of an append, the history could end with an
 * assistant tool call that never got its result (the API rejects that).
 * Drop such a dangling tail.
 */
export function repairTail(messages: AgentMessage[]): AgentMessage[] {
  const out = [...messages];
  while (out.length) {
    const last = out[out.length - 1]!;
    if (last.role === "assistant" && Array.isArray(last.content) && last.content.some((p: any) => p?.type === "tool-call")) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}
