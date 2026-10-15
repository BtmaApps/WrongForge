/** API key handling + fetch/SSE helpers. The key lives in localStorage. */

import type { TaskEvent } from "./types.js";

const KEY_STORAGE = "wrongforge.key";

export function loadKey(): string {
  // ?key=... on the URL wins once (then it is stripped so it cannot leak into
  // copies/links), otherwise the remembered key.
  const fromUrl = new URLSearchParams(location.search).get("key");
  if (fromUrl) {
    localStorage.setItem(KEY_STORAGE, fromUrl);
    history.replaceState(null, "", location.pathname);
    return fromUrl;
  }
  return localStorage.getItem(KEY_STORAGE) ?? "";
}

export function saveKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export type SseStatus = "connecting" | "open" | "reconnecting";

/**
 * A fetch-based SSE client for GET /v1/events (the stream uses named events,
 * so we parse frames ourselves; fetch also lets us abort cleanly).
 * Reconnects with capped backoff and reports every (re)open so the caller can
 * refresh its snapshot — the global feed is live-only.
 */
export function connectEvents(
  key: string,
  onEvent: (ev: TaskEvent) => void,
  onStatus: (s: SseStatus) => void,
): () => void {
  let stopped = false;
  let retry = 0;
  const ctrl = new AbortController();

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        onStatus(retry === 0 ? "connecting" : "reconnecting");
        const res = await fetch(`/v1/events?key=${encodeURIComponent(key)}`, {
          headers: { Accept: "text/event-stream" },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        retry = 0;
        onStatus("open");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let split: number;
          while ((split = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, split);
            buf = buf.slice(split + 2);
            let type = "";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) type = line.slice(7).trim();
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (data) {
              try {
                onEvent(JSON.parse(data) as TaskEvent);
              } catch {
                /* skip a malformed frame */
              }
            }
          }
        }
      } catch {
        /* aborted or the connection dropped — fall through to the backoff */
      }
      if (stopped) return;
      retry++;
      onStatus("reconnecting");
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** Math.min(retry, 5), 10_000)));
    }
  };
  void loop();
  return () => {
    stopped = true;
    ctrl.abort();
  };
}
