import { tool } from "ai";
import { z } from "zod";
import { isBinary } from "./util.js";
import {
  BINARY_TYPE_RE,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_REDIRECTS,
  TEXT_TYPE_RE,
  assertPublicUrl,
  decodeBody,
  htmlToText,
  readCapped,
} from "./web-utils.js";

export const web_fetch = tool({
  description:
    "Fetches an HTTP(S) URL and returns the page as readable text (HTML is " +
    "converted keeping paragraphs and lists; the title is returned separately). " +
    "Use it to read documentation or APIs. Only public hosts (redirects are " +
    "re-checked); no credentials are attached; binary content is not returned. " +
    "Non-2xx responses still return their body with ok=false.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to fetch (http/https)"),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .optional()
      .describe("Max characters to return (default 20000)"),
  }),
  execute: async ({ url, max_chars }) => {
    try {
      // follow redirects manually so every hop is checked against the
      // public-address rule (a public URL must not redirect to an internal one)
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      let current = (await assertPublicUrl(url)).href;
      let res: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        res = await fetch(current, {
          redirect: "manual",
          signal,
          headers: { Accept: "text/html,application/json,text/plain,*/*" },
        });
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc) {
          if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
          current = (await assertPublicUrl(new URL(loc, current).href)).href;
          continue;
        }
        break;
      }
      if (!res) throw new Error("no response");
      const contentType = res.headers.get("content-type") ?? "";
      const { buf, capped } = await readCapped(res, MAX_FETCH_BYTES);

      const textual =
        TEXT_TYPE_RE.test(contentType) || (!BINARY_TYPE_RE.test(contentType) && !isBinary(buf));
      if (!textual) {
        return {
          ok: res.ok,
          status: res.status,
          url: current,
          contentType,
          bytes: buf.length,
          text: "",
          note: "binary content — not shown (download it with bash/curl if needed)",
        };
      }

      const decoded = decodeBody(buf, contentType);
      let text = decoded;
      let title: string | null = null;
      if (/html/i.test(contentType) || (!contentType && /^\s*<(!doctype|html)/i.test(decoded))) {
        ({ title, text } = htmlToText(decoded));
      }
      const cap = max_chars ?? 20_000;
      const cut = text.length > cap;
      return {
        ok: res.ok,
        status: res.status,
        url: current,
        contentType,
        ...(title && { title }),
        truncated: cut || capped,
        text: cut ? text.slice(0, cap) + "\n…[truncated]" : text,
      };
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        return { ok: false, error: `request timed out after ${FETCH_TIMEOUT_MS / 1000}s` };
      }
      return { ok: false, error: err.message };
    }
  },
});
