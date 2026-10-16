/**
 * web_fetch support: public-host safety checks, bounded body reading,
 * HTML → text conversion and charset handling.
 */

import * as dns from "node:dns/promises";
import * as net from "node:net";

export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 30_000;

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 || // multicast, reserved, broadcast
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local (cloud metadata)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    // URL parsing canonicalises IPv6 to the compressed hex form, so a host
    // written "::ffff:127.0.0.1" always arrives here as "::ffff:7f00:1": read
    // the low 32 bits of both spellings, or a mapped host reads as public.
    const s = canonicalIpv6(ip);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return (
      s === "::" ||
      s === "::1" ||
      s.startsWith("fc") ||
      s.startsWith("fd") || // unique local fc00::/7
      /^fe[89ab]/.test(s) // link-local fe80::/10
    );
  }
  return true; // not an IP literal: treat as unsafe
}

/** Lower-cased, compressed IPv6 text (the WHATWG form). `ip` is already valid. */
function canonicalIpv6(ip: string): string {
  try {
    return new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return ip.toLowerCase();
  }
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported protocol ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error("blocked: URLs with embedded credentials are not allowed");
  }
  // Tests only: allows the offline suite to exercise the fetch loop against
  // a local mock server. Never set in production.
  if (process.env.WRONGFORGE_ALLOW_PRIVATE_URLS === "1") return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
    throw new Error(`blocked: ${host} is not a public address`);
  }
  return u;
}

export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ buf: Buffer; capped: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), capped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      finished = true;
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  // the loop stops on the counter, not on the stream: a body that ends exactly
  // at maxBytes exits here too, so ask once more before calling it truncated
  if (!finished) finished = (await reader.read()).done;
  await reader.cancel().catch(() => {});
  const all = Buffer.concat(chunks);
  return { buf: all.subarray(0, maxBytes), capped: !finished || all.length > maxBytes };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** One pass, so `&amp;lt;` becomes `&lt;` (not `<`). Unknown entities stay. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Turns HTML into readable plain text, keeping paragraph/list structure. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = t ? decodeEntities(t[1]).replace(/\s+/g, " ").trim() || null : null;
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(
        /<\/(p|div|section|article|header|footer|main|nav|aside|ul|ol|table|tr|pre|blockquote|h[1-6]|form|figure|dl|dt|dd)>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export const TEXT_TYPE_RE = /^text\/|json|xml|javascript|ecmascript|yaml|toml|csv|svg|markdown|x-sh/i;
export const BINARY_TYPE_RE = /^(image|audio|video|font)\/|octet-stream|pdf|zip|gzip|wasm/i;

export function decodeBody(buf: Buffer, contentType: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  if (m && !/^utf-?8$/i.test(m[1])) {
    try {
      return new TextDecoder(m[1]).decode(buf);
    } catch {
      /* unknown charset: fall through to utf8 */
    }
  }
  return buf.toString("utf8");
}
