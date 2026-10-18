/**
 * Claude OAuth — the same flow used by Claude Code / Claude Desktop.
 *
 * Wire protocol (verified against the live endpoints + carved from CC 2.1.300,
 * re/notes/findings.md §11):
 *   - Authorize : {authorizeUrl}  (PKCE S256, public client)
 *   - Token     : POST {tokenUrl}  (JSON body, claude-cli User-Agent)
 *   - Signing   : Authorization: Bearer <token> + anthropic-beta: oauth-2025-04-20
 *
 * Client identity values (client ID etc.) are NOT part of the code — they are
 * loaded from env vars or a user config file (see src/config.ts).
 *
 * Privacy: nothing machine-specific is ever transmitted. The only values sent
 * are the OAuth protocol fields (client_id from your config, redirect_uri,
 * scope, one-time PKCE challenge/state) and the Bearer token itself. There is
 * no device ID, no persistent fingerprint, and no telemetry headers.
 *
 * Login flow: the browser shows a code at the redirect page and the user
 * pastes it into the terminal (the standard Claude Code CLI flow).
 * Note: loopback redirects are NOT supported for this client — the server
 * rejects any http://127.0.0.1:<port>/callback redirect_uri.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { dataDir } from "./paths.js";
import {
  loadOAuthConfig,
  configHelp,
  type OAuthConfig,
} from "./config.js";

/** Protocol constants — public API version strings, not identifiers. */
export const PROTOCOL = {
  anthropicVersion: "2023-06-01",
  oauthBeta: "oauth-2025-04-20",
} as const;

/**
 * The Claude Code CLI user-agent, captured verbatim from real client traffic
 * (re/notes/cc-capture.jsonl). Shared by the provider's /v1/messages calls and
 * the OAuth token endpoint below: the subscription backend serves one client
 * class everywhere — a generic `anthropic` UA on the token endpoint gets
 * 429-rate-limited while the real client refreshes freely with the same
 * account, IP and client id (issue #3).
 */
export const CLAUDE_CODE_UA = "claude-cli/2.1.300 (external, sdk-cli)";

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function makePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

const randomState = (): string => crypto.randomBytes(24).toString("base64url");

// ---------------------------------------------------------------------------
// Encrypted token store (AES-256-GCM; key in a separate 0600 file)
// ---------------------------------------------------------------------------

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** Unix ms — Date.now() + expires_in * 1000 */
  expiresAt: number;
  scope: string;
  /**
   * Unix ms the REFRESH token itself dies (not the access token above) —
   * Date.now() + refresh_token_expires_in * 1000, when the token endpoint
   * sends that field (carved from CC 2.1.300's own token-response handling,
   * mod-0150 `jPr()`: ~30 days, renewed on every successful refresh). Absent
   * when the endpoint didn't send it — older stored tokens predate this field
   * too — in which case it is treated as unknown, not expired.
   */
  refreshTokenExpiresAt?: number;
}

class TokenStore {
  private readonly file: string;
  private readonly keyFile: string;

  constructor(file: string) {
    this.file = file;
    this.keyFile = file + ".key";
  }

  private masterKey(): Buffer {
    try {
      const k = fs.readFileSync(this.keyFile);
      if (k.length === 32) return k;
    } catch {
      /* generated on first use */
    }
    const k = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, k, { mode: 0o600 });
    return k;
  }

  load(): StoredToken | null {
    try {
      const raw = fs.readFileSync(this.file);
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey(), iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]);
      return JSON.parse(plain.toString("utf8")) as StoredToken;
    } catch {
      return null;
    }
  }

  save(token: StoredToken): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey(), iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(token), "utf8"),
      cipher.final(),
    ]);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, Buffer.concat([iv, cipher.getAuthTag(), body]), {
      mode: 0o600,
    });
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

// ---------------------------------------------------------------------------
// OAuth client
// ---------------------------------------------------------------------------

/**
 * Token endpoint call — a JSON body (the shape Claude Code itself sends,
 * carved from CC 2.1.300: `Tt.post(TOKEN_URL, body, {headers:{"Content-Type":
 * "application/json"}, timeout:30000})`) under the Claude Code user-agent.
 * The body format does not gate the endpoint, the User-Agent does: a generic
 * `anthropic` UA gets 429 rate_limit_error while claude-cli / no-UA requests
 * are processed (400 invalid_grant) — probe-verified, re/notes/findings.md
 * §11; that UA was the root cause of issue #3's refresh failures.
 *
 * The endpoint rate-limits aggressively; on HTTP 429 this waits (honoring
 * Retry-After) and retries a few times before giving up.
 */
async function tokenPost(
  url: string,
  body: Record<string, string>,
  maxAttempts = 5,
): Promise<{ status: number; json: any }> {
  let last: { status: number; json: any } = { status: 0, json: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CLAUDE_CODE_UA,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    last = { status: res.status, json };
    if (res.status !== 429) return last;

    const retryAfter = Number(res.headers.get("retry-after"));
    const waitSec = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 120)
      : Math.min(2 ** (attempt - 1), 30); // 1s, 2s, 4s, 8s, … capped at 30s
    console.log(
      `[auth] rate limited (429) — retrying in ${waitSec}s (attempt ${attempt}/${maxAttempts})`,
    );
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
  return last;
}

function openBrowser(url: string): void {
  // shell-free spawn: prevents cmd/bash from interpreting &, %, ?
  // Windows: rundll32 is the most reliable shell-free opener; cmd `start`
  // is the fallback. Both receive the URL as a single argv element.
  const trySpawn = (cmd: string, args: string[]): boolean => {
    try {
      spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch {
      return false;
    }
  };
  if (process.platform === "win32") {
    if (!trySpawn("rundll32.exe", ["url.dll,FileProtocolHandler", url])) {
      trySpawn("cmd.exe", ["/c", "start", "", url]);
    }
  } else if (process.platform === "darwin") {
    trySpawn("open", [url]);
  } else {
    trySpawn("xdg-open", [url]);
  }
}

export interface LoginOptions {
  /** do not auto-open the browser (CI/headless) */
  noBrowser?: boolean;
  scope?: string;
}

/**
 * Parses what the user pastes after login. The redirect page shows the code
 * as "code#state"; a bare code or a full callback URL are also accepted.
 * Validates the state when one is present.
 */
export function parsePastedCode(input: string, expectedState: string): string {
  const raw = input.trim();
  let code = raw;
  let state: string | undefined;
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    code = u.searchParams.get("code") ?? "";
    state = u.searchParams.get("state") ?? undefined;
  } else if (raw.includes("#")) {
    const i = raw.indexOf("#");
    code = raw.slice(0, i);
    state = raw.slice(i + 1);
  }
  if (!code) throw new Error("authorization code is empty");
  if (state !== undefined && state !== expectedState) {
    throw new Error(
      "state mismatch — this code belongs to a different login attempt; run `npm run login` again",
    );
  }
  return code;
}

export class ClaudeOAuth {
  private readonly store: TokenStore;
  private token: StoredToken | null;
  private inflightRefresh: Promise<StoredToken | null> | null = null;
  /** Set when Claude Code recovery itself failed — stop retrying this process. */
  private recoveryExhausted = false;
  /**
   * Bumped every time `this.token` is replaced from any path (login, import,
   * logout, a completed refresh). A refresh captures it before it suspends and
   * compares after, so a response that belongs to a superseded session is
   * dropped instead of overwriting — and re-persisting — the newer one.
   */
  private tokenGeneration = 0;
  /** Why the last refresh failed, so the caller learns the cause, not just
   *  "run npm run import" (F503). Null until a refresh actually fails. */
  private lastRefreshError: string | null = null;

  constructor(storePath?: string) {
    this.store = new TokenStore(
      storePath ?? path.join(dataDir(), "tokens.json"),
    );
    this.token = this.store.load();
  }

  /** OAuth client config; null when the client ID is not configured yet. */
  get config(): OAuthConfig | null {
    return loadOAuthConfig();
  }

  private requireConfig(): OAuthConfig {
    const cfg = this.config;
    if (!cfg) throw new Error(configHelp());
    return cfg;
  }

  get signedIn(): boolean {
    return this.token !== null;
  }

  status(): object {
    const cfg = this.config;
    return {
      signedIn: this.signedIn,
      clientConfigured: cfg !== null,
      accessTokenExpiresAt: this.token?.expiresAt ?? null,
      /** null = unknown (the endpoint hasn't told us) — not "never expires".
       *  See the refresh-token-expiry note on StoredToken; `wrongforge
       *  refresh` run periodically (e.g. weekly, outside `serve`) keeps this
       *  far from its actual deadline. */
      refreshTokenExpiresAt: this.token?.refreshTokenExpiresAt ?? null,
      scope: this.token?.scope ?? cfg?.scope ?? null,
      tokenUrl: cfg?.tokenUrl ?? null,
    };
  }

  /**
   * Builds the authorize URL with PKCE + state (client_id first — the safest
   * position when the URL is partially copied from a terminal). Carries
   * `code=true` because the live backend scopes the grant down when it is
   * absent (carved from CC 2.1.300's own authorize-URL builder, `WPr` in
   * mod-0150: it always sends this flag; see re/notes/findings.md §12 —
   * a community report of a refresh token that came back with only
   * `user:profile`, missing `user:inference`, traces to this).
   */
  buildAuthorizeUrl(
    codeChallenge: string,
    state: string,
    redirectUri: string,
    scope: string,
  ): string {
    const u = new URL(this.requireConfig().authorizeUrl);
    u.searchParams.set("client_id", this.requireConfig().clientId);
    u.searchParams.set("code", "true");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", scope);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", state);
    return u.toString();
  }

  /** Writes the login URL to a single-line file — unaffected by terminal
   *  line wrapping, always complete when copied. */
  private writeLoginUrlFile(url: string): string {
    const file = path.join(
      path.dirname(
        process.env.CLAUDE_TOKEN_STORE ??
          path.join(dataDir(), "tokens.json"),
      ),
      "login-url.txt",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, url + "\n", { mode: 0o600 });
    return file;
  }

  // ------------------------------------------------------------------
  // Login — the standard Claude Code flow: the browser shows a code at the
  // redirect page, the user pastes it here.
  // ------------------------------------------------------------------

  async login(opts: LoginOptions = {}): Promise<StoredToken> {
    const cfg = this.requireConfig();
    const scope = opts.scope ?? cfg.scope;
    const { codeVerifier, codeChallenge } = makePkce();
    const state = randomState();
    const redirectUri = cfg.redirectUri;

    const url = this.buildAuthorizeUrl(codeChallenge, state, redirectUri, scope);
    const urlFile = this.writeLoginUrlFile(url);
    console.log("\nLog in with your Claude account in the browser.\n");
    if (!opts.noBrowser) openBrowser(url);
    console.log(`  ${url}\n`);
    console.log(
      `If the browser did not open, copy the URL from this file (single line, complete):\n  ${urlFile}\n`,
    );
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const pasted = await rl.question(
      "Paste the authorization code shown in the browser: ",
    );
    rl.close();
    const code = parsePastedCode(pasted, state);

    return this.exchangeCode(code, codeVerifier, redirectUri, scope, state);
  }

  // ------------------------------------------------------------------
  // authorization_code -> token (POST /v1/oauth/token, urlencoded body)
  // body: grant_type, code, code_verifier, client_id, redirect_uri, state
  // ------------------------------------------------------------------

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    scope: string,
    state?: string,
  ): Promise<StoredToken> {
    const cfg = this.requireConfig();
    const res = await tokenPost(cfg.tokenUrl, {
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      ...(state !== undefined ? { state } : {}),
    });
    if (res.status !== 200 || !res.json?.access_token) {
      throw new Error(
        `token exchange HTTP ${res.status}: ${JSON.stringify(res.json)}`,
      );
    }
    console.log("[auth] login successful, token received");
    return this.applyTokenResponse(res.json, scope);
  }

  // ------------------------------------------------------------------
  // Refresh — grant_type=refresh_token (no Bearer header)
  // ------------------------------------------------------------------

  async refresh(): Promise<StoredToken | null> {
    if (this.inflightRefresh) return this.inflightRefresh;
    const current = this.token;
    if (!current?.refreshToken) return null;
    const generation = this.tokenGeneration;
    this.inflightRefresh = (async () => {
      try {
        const res = await tokenPost(this.requireConfig().tokenUrl, {
          grant_type: "refresh_token",
          client_id: this.requireConfig().clientId,
          refresh_token: current.refreshToken,
          // CC sends the granted scope on every refresh (mod-0150 See())
          scope: current.scope,
        });
        // The session was replaced while we were suspended (login, import or
        // logout): this response belongs to a superseded token — drop it rather
        // than overwrite the newer session in memory and on disk.
        if (this.tokenGeneration !== generation) {
          console.log("[auth] token refreshed concurrently — keeping the newer session");
          return this.token;
        }
        if (res.status !== 200 || !res.json?.access_token) {
          console.error(
            `[auth] refresh HTTP ${res.status}: ${JSON.stringify(res.json)}`,
          );
          // our refresh token is dead — Claude Code's own session may still
          // be alive (it refreshes independently); adopt it instead of
          // failing every task until someone runs `npm run import`
          return await this.recoverFromClaudeCode();
        }
        this.applyTokenResponse(res.json, current.scope);
        this.lastRefreshError = null;
        console.log("[auth] token refreshed");
        return this.token;
      } catch (e) {
        this.lastRefreshError = (e as Error).message;
        console.error(`[auth] refresh network error: ${(e as Error).message}`);
        return null;
      } finally {
        this.inflightRefresh = null;
      }
    })();
    return this.inflightRefresh;
  }

  /**
   * Self-healing for a rejected refresh token: adopt Claude Code's session
   * from ~/.claude/.credentials.json (what `npm run import` does manually)
   * and, when its access token is already expired, refresh that once through
   * the same endpoint. Returns null when there is nothing to recover from;
   * a recovery that itself fails is remembered so we do not hammer the token
   * endpoint on every request. Disable with WRONGFORGE_CC_RECOVERY=0.
   */
  private async recoverFromClaudeCode(): Promise<StoredToken | null> {
    if (this.recoveryExhausted || process.env.WRONGFORGE_CC_RECOVERY === "0") return null;
    let imported: StoredToken;
    try {
      imported = this.importFromClaudeCode();
    } catch (e) {
      // Not fatal — there may simply be no Claude Code on this machine. But
      // silence here is what made self-healing undebuggable: a CORRUPT
      // credentials file looked identical to "Claude Code absent", and the
      // operator got no clue why recovery never engaged.
      console.warn(`[auth] nothing to adopt from Claude Code (${(e as Error).message})`);
      return null;
    }
    if (imported.expiresAt - 60_000 > Date.now()) {
      console.warn("[auth] refresh token rejected — adopted Claude Code's session automatically");
      return imported;
    }
    try {
      const res = await tokenPost(this.requireConfig().tokenUrl, {
        grant_type: "refresh_token",
        client_id: this.requireConfig().clientId,
        refresh_token: imported.refreshToken,
        scope: imported.scope,
      });
      if (res.status === 200 && res.json?.access_token) {
        console.warn("[auth] refresh token rejected — adopted Claude Code's session and refreshed it");
        this.applyTokenResponse(res.json, imported.scope);
        return this.token;
      }
      this.recoveryExhausted = true;
      console.error(
        `[auth] Claude Code's session cannot refresh either (HTTP ${res.status}) — run Claude Code once, then \`npm run import\` (or \`npm run login\`)`,
      );
      return null;
    } catch (e) {
      this.recoveryExhausted = true;
      console.error(`[auth] recovery refresh network error: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Applies a token response, deriving expires_at from expires_in.
   *
   * This is the trust boundary: `body` is whatever the remote token endpoint
   * returned, and the result is both served to callers and written to disk. A
   * non-numeric `expires_in` (e.g. the string "soon") would make expiresAt NaN,
   * and every comparison against NaN is false — so the token would look valid
   * forever — while JSON.stringify(NaN) persists as null, which flips the same
   * record to "expired" after a restart and refreshes on every call. Reject a
   * malformed response instead of storing it (F502).
   */
  private applyTokenResponse(body: any, scope: string): StoredToken {
    if (typeof body?.access_token !== "string" || !body.access_token) {
      throw new Error("token response contained no usable access_token");
    }
    const rawExpiresIn = body.expires_in;
    const expiresIn =
      typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
        ? rawExpiresIn
        : 3600; // absent or malformed -> the documented one-hour default
    const refreshToken =
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : this.token?.refreshToken ?? "";
    // The endpoint doesn't always send refresh_token_expires_in (e.g. a
    // concurrent-refresh race may return a thin body) — carry the previous
    // value forward rather than treat a silent field as "the refresh token
    // is now immortal" (mirrors CC's own yE(): n.refreshTokenExpiresAt ??
    // e?.refreshTokenExpiresAt).
    const rawRefreshExpiresIn = body.refresh_token_expires_in;
    const refreshTokenExpiresAt =
      typeof rawRefreshExpiresIn === "number" && Number.isFinite(rawRefreshExpiresIn) && rawRefreshExpiresIn > 0
        ? Date.now() + rawRefreshExpiresIn * 1000
        : this.token?.refreshTokenExpiresAt;
    const t: StoredToken = {
      accessToken: body.access_token,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      scope: typeof body.scope === "string" && body.scope ? body.scope : scope,
      ...(refreshTokenExpiresAt !== undefined && { refreshTokenExpiresAt }),
    };
    this.token = t;
    this.tokenGeneration++;
    this.store.save(t);
    return t;
  }

  /**
   * Fresh access token; proactively refreshes within the last `refreshMarginMs`
   * (default 60 s). The server's idle keep-alive passes a wider margin so the
   * token chain never goes stale between tasks — see startEnvServer.
   */
  async getAccessToken(refreshMarginMs = 60_000): Promise<string> {
    if (!this.token) throw new Error("not signed in — run `npm run login` first");
    if (this.token.expiresAt - refreshMarginMs <= Date.now()) {
      const fresh = await this.refresh();
      if (!fresh) {
        const cause = this.lastRefreshError ? ` (${this.lastRefreshError})` : "";
        throw new Error(
          `token refresh failed${cause} — run Claude Code once, then \`npm run import\` (or \`npm run login\`)`,
        );
      }
      return fresh.accessToken;
    }
    return this.token.accessToken;
  }

  logout(): void {
    this.store.clear();
    this.token = null;
    this.tokenGeneration++;
  }

  // ------------------------------------------------------------------
  // Import — reuse an existing Claude Code CLI session instead of a new
  // login. Reads claudeAiOauth from ~/.claude/.credentials.json (or the
  // macOS Keychain, where Claude Code 2.1.302+ keeps it) and stores it in
  // this app's token store; refreshes through the same endpoint.
  // ------------------------------------------------------------------

  importFromClaudeCode(filePath?: string): StoredToken {
    const file =
      filePath ??
      process.env.CLAUDE_CREDENTIALS_FILE ??
      path.join(os.homedir(), ".claude", ".credentials.json");
    let text: string;
    let source: string;
    try {
      text = fs.readFileSync(file, "utf8");
      source = file;
    } catch (e) {
      // Claude Code 2.1.302+ dropped the legacy plain file for the macOS
      // Keychain — fall back to reading it there (issue #3). Off darwin the
      // reader finds nothing and the original read error is reported.
      const fromKeychain = keychainReader();
      if (fromKeychain === null) {
        throw new Error(
          `cannot read ${file} — is Claude Code installed and logged in? (${(e as Error).message})` +
            (process.platform === "darwin"
              ? `; the macOS Keychain has no "Claude Code-credentials" item for this user either`
              : ""),
        );
      }
      text = fromKeychain;
      source = `the macOS Keychain ("Claude Code-credentials")`;
    }
    let raw: any;
    try {
      // A UTF-8 BOM is invisible in an editor and is written by plenty of
      // Windows tooling, but it makes JSON.parse fail on the very first byte.
      raw = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (e) {
      // Distinct from a read failure: the source WAS read, its contents are bad.
      throw new Error(
        `${source} is not valid JSON (${(e as Error).message}) — Claude Code may have been interrupted while writing it`,
      );
    }
    // The Keychain item holds the same document the file did; a bare
    // claudeAiOauth object (no wrapper) is accepted too, in case the storage
    // shape ever peels it off.
    const o = raw?.claudeAiOauth ?? (raw?.accessToken ? raw : undefined);
    if (!o?.accessToken) {
      throw new Error(`no claudeAiOauth.accessToken in ${source} — sign in with Claude Code, then retry`);
    }
    const t: StoredToken = {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken ?? "",
      expiresAt:
        typeof o.expiresAt === "number" ? o.expiresAt : Date.now() + 3600_000,
      scope: Array.isArray(o.scopes)
        ? o.scopes.join(" ")
        : "user:inference user:profile",
    };
    this.token = t;
    this.tokenGeneration++;
    this.store.save(t);
    console.log(
      `[auth] imported Claude Code session from ${source} (expires ${new Date(t.expiresAt).toISOString()})`,
    );
    return t;
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain — where Claude Code 2.1.302+ keeps its credentials
// ---------------------------------------------------------------------------

/**
 * Reads Claude Code's credentials from the macOS Keychain: service
 * `Claude Code-credentials`, account = the local macOS username; `security
 * find-generic-password … -w` prints the stored JSON on stdout. Returns null
 * when there is nothing to find — not macOS (no `security` binary), keychain
 * locked, no item for this user — so callers can keep their own error path.
 * Never logs: the value is a credential.
 */
function readKeychainCredentials(): string | null {
  let account: string;
  try {
    account = os.userInfo().username;
  } catch {
    return null;
  }
  if (!account) return null;
  try {
    const out = spawnSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-a", account, "-w"],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (out.error || out.status !== 0 || !out.stdout?.trim()) return null;
    return out.stdout.trim();
  } catch {
    return null;
  }
}

/** The keychain reader in use — replaceable so non-macOS tests can exercise
 *  the import fallback (there is no `security` CLI to spawn there). */
let keychainReader: () => string | null = readKeychainCredentials;

/** Test seam: swap the macOS Keychain reader; null restores the real one. */
export function setKeychainReaderForTest(fn: (() => string | null) | null): void {
  keychainReader = fn ?? readKeychainCredentials;
}
