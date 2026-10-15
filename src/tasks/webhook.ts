/**
 * Webhook delivery of task events to the orchestrator.
 *
 * - Per-task ORDER: events of one task are delivered strictly one after the
 *   other (a retrying event blocks the ones behind it); different tasks are
 *   delivered in parallel.
 * - At-least-once: network errors, timeouts, HTTP 5xx / 408 / 429 are retried
 *   with exponential backoff; the same `X-WrongForge-Delivery` id is reused on
 *   retries so the receiver can de-duplicate (or use task_id + seq).
 * - Other 4xx responses are not retried (the receiver rejected the event).
 * - Signed: `X-WrongForge-Signature: sha256=<hex>` = HMAC-SHA256(key,
 *   "<X-WrongForge-Timestamp>.<raw body>").
 * - Best effort: a permanently failing receiver never affects the task.
 *   Events stay available through the events API (use `seq` to detect gaps).
 */

import * as crypto from "node:crypto";
import type { Logger } from "../log.js";
import { sanitize } from "../log.js";
import type { CallbackSpec, TaskEvent } from "./types.js";
import { VERSION } from "../paths.js";

export interface WebhookOptions {
  /** HMAC key. */
  key: string;
  logger?: Logger;
  /** Attempts per event, including the first (default 6). */
  maxAttempts?: number;
  /** First retry delay (default 1000 ms), doubled each time. */
  baseDelayMs?: number;
  /** Retry delay cap (default 60 000 ms). */
  maxDelayMs?: number;
  /** Per-request timeout (default 10 000 ms). */
  timeoutMs?: number;
  /** Strings inside `data` are cut to this length in webhook bodies (default 4000). */
  maxFieldChars?: number;
  /** Test hook. */
  fetchImpl?: typeof fetch;
}

/** Default: everything except raw text deltas. */
export const DEFAULT_CALLBACK_EVENTS = ["task.*", "step.*", "agent.report", "agent.todos", "tool.*"];

export function eventMatches(patterns: readonly string[] | undefined, type: string): boolean {
  const list = patterns && patterns.length ? patterns : DEFAULT_CALLBACK_EVENTS;
  return list.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}

export function signPayload(key: string, timestamp: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
}

export type DeliveryResult = { ok: true; attempts: number } | { ok: false; attempts: number; error: string };

export class WebhookDispatcher {
  private chains = new Map<string, Promise<unknown>>();
  private readonly o: Required<Omit<WebhookOptions, "logger" | "fetchImpl">> & Pick<WebhookOptions, "logger" | "fetchImpl">;

  constructor(opts: WebhookOptions) {
    this.o = {
      key: opts.key,
      logger: opts.logger,
      fetchImpl: opts.fetchImpl,
      maxAttempts: opts.maxAttempts ?? 6,
      baseDelayMs: opts.baseDelayMs ?? 1000,
      maxDelayMs: opts.maxDelayMs ?? 60_000,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxFieldChars: opts.maxFieldChars ?? 4000,
    };
  }

  /** Queues `ev` for delivery (respecting the callback's event filter). */
  enqueue(spec: CallbackSpec, ev: TaskEvent, onDone?: (r: DeliveryResult) => void): void {
    if (!eventMatches(spec.events, ev.type)) return;
    const prev = this.chains.get(ev.task_id) ?? Promise.resolve();
    const next = prev
      .then(() => this.deliver(spec.url, ev))
      .then((r) => onDone?.(r))
      .catch(() => undefined);
    this.chains.set(ev.task_id, next);
    void next.finally(() => {
      if (this.chains.get(ev.task_id) === next) this.chains.delete(ev.task_id);
    });
  }

  /** Resolves when every queued delivery has finished (shutdown, tests). */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private async deliver(url: string, ev: TaskEvent): Promise<DeliveryResult> {
    const body = JSON.stringify({ ...ev, data: sanitize(ev.data, this.o.maxFieldChars) });
    const delivery = crypto.randomUUID();
    const doFetch = this.o.fetchImpl ?? fetch;
    let lastError = "";

    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      let retryable = true;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `WrongForge/${VERSION}`,
            "X-WrongForge-Event": ev.type,
            "X-WrongForge-Task": ev.task_id,
            "X-WrongForge-Seq": String(ev.seq),
            "X-WrongForge-Delivery": delivery,
            "X-WrongForge-Attempt": String(attempt),
            "X-WrongForge-Timestamp": timestamp,
            "X-WrongForge-Signature": signPayload(this.o.key, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        // drain so the connection can be reused
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) {
          this.o.logger?.info("webhook.delivered", {
            task_id: ev.task_id, seq: ev.seq, type: ev.type, url, attempt, status: res.status,
          });
          return { ok: true, attempts: attempt };
        }
        lastError = `HTTP ${res.status}`;
        retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      } catch (e) {
        lastError = (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message;
      }

      if (!retryable || attempt === this.o.maxAttempts) {
        this.o.logger?.error("webhook.failed", {
          task_id: ev.task_id, seq: ev.seq, type: ev.type, url, attempts: attempt, error: lastError,
          retryable,
        });
        return { ok: false, attempts: attempt, error: lastError };
      }
      const delay = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** (attempt - 1));
      this.o.logger?.warn("webhook.retry", {
        task_id: ev.task_id, seq: ev.seq, type: ev.type, url, attempt, error: lastError, retry_in_ms: delay,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
    return { ok: false, attempts: this.o.maxAttempts, error: lastError };
  }
}
