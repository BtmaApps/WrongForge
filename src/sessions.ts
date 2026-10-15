/**
 * Durable conversation sessions.
 *
 *   <dir>/<session_id>/session.json     metadata (atomic write: tmp + rename)
 *   <dir>/<session_id>/messages.jsonl   one ModelMessage per line, append-only
 *
 * A session is the model's conversation memory. A task that names a
 * `session_id` continues that conversation — also after a server restart.
 * Messages are appended only after a turn SUCCEEDED, so a failed / cancelled
 * task never leaves a half turn behind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelMessage } from "ai";

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
  /** Last task that ran in this session. */
  last_task_id?: string;
  /** Most recent task ids (capped). */
  task_ids: string[];
}

export interface LoadedSession {
  meta: SessionMeta;
  messages: ModelMessage[];
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
    newMessages: ModelMessage[],
    info: { task_id: string; model: string; prompt: string },
    now = new Date(),
  ): SessionMeta {
    const meta = this.readMeta(id);
    if (!meta) throw new Error(`no such session: ${id}`);
    if (newMessages.length) {
      const lines = newMessages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      fs.appendFileSync(path.join(this.sdir(id), "messages.jsonl"), lines);
    }
    meta.message_count += newMessages.length;
    meta.turns += 1;
    meta.updated_at = now.toISOString();
    meta.model = info.model;
    meta.last_task_id = info.task_id;
    meta.task_ids = [...meta.task_ids, info.task_id].slice(-MAX_TASK_IDS);
    if (!meta.title) meta.title = info.prompt.replace(/\s+/g, " ").trim().slice(0, 80);
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
  page(id: string, offset = 0, limit = 100): { total: number; messages: ModelMessage[] } | null {
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

  private readMessages(id: string): ModelMessage[] {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.sdir(id), "messages.jsonl"), "utf8");
    } catch {
      return [];
    }
    const out: ModelMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ModelMessage);
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
export function repairTail(messages: ModelMessage[]): ModelMessage[] {
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
