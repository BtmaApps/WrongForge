/**
 * Claude OAuth — the same flow used by Claude Code / Claude Desktop.
 *
 * Wire protocol (verified against the live endpoints):
 *   - Authorize : {authorizeUrl}  (PKCE S256, public client)
 *   - Token     : POST {tokenUrl}  (urlencoded body)
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
import { spawn } from "node:child_process";
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
 * Token endpoint call — JSON body (not the urlencoded OAuth default):
 *   Content-Type: application/json
 *   User-Agent: anthropic
 * The wire shape below matches the flow the endpoint actually accepts;
 * api.anthropic.com's token endpoint rejects this flow ("Invalid request
 * format") — only console.anthropic.com/v1/oauth/token serves it.
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
        "User-Agent": "anthropic",
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
      scope: this.token?.scope ?? cfg?.scope ?? null,
      tokenUrl: cfg?.tokenUrl ?? null,
    };
  }

  /** Builds the authorize URL with PKCE + state (client_id first — the safest
   *  position when the URL is partially copied from a terminal). */
  buildAuthorizeUrl(
    codeChallenge: string,
    state: string,
    redirectUri: string,
    scope: string,
  ): string {
    const u = new URL(this.requireConfig().authorizeUrl);
    u.searchParams.set("client_id", this.requireConfig().clientId);
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
  // authorization_code -> token (POST /v1/oauth/token, JSON body)
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
    this.token = this.applyTokenResponse(res.json, scope);
    console.log("[auth] login successful, token received");
    return this.token;
  }

  // ------------------------------------------------------------------
  // Refresh — grant_type=refresh_token (no Bearer header)
  // ------------------------------------------------------------------

  async refresh(): Promise<StoredToken | null> {
    if (this.inflightRefresh) return this.inflightRefresh;
    const current = this.token;
    if (!current?.refreshToken) return null;
    this.inflightRefresh = (async () => {
      try {
        const res = await tokenPost(this.requireConfig().tokenUrl, {
          grant_type: "refresh_token",
          client_id: this.requireConfig().clientId,
          refresh_token: current.refreshToken,
        });
        if (res.status !== 200 || !res.json?.access_token) {
          console.error(
            `[auth] refresh HTTP ${res.status}: ${JSON.stringify(res.json)}`,
          );
          return null;
        }
        this.token = this.applyTokenResponse(res.json, current.scope);
        console.log("[auth] token refreshed");
        return this.token;
      } catch (e) {
        console.error(`[auth] refresh network error: ${(e as Error).message}`);
        return null;
      } finally {
        this.inflightRefresh = null;
      }
    })();
    return this.inflightRefresh;
  }

  /** Applies a token response, deriving expires_at from expires_in. */
  private applyTokenResponse(body: any, scope: string): StoredToken {
    const t: StoredToken = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? this.token?.refreshToken ?? "",
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? scope,
    };
    this.store.save(t);
    return t;
  }

  /** Fresh access token; proactively refreshes within the last 60s. */
  async getAccessToken(): Promise<string> {
    if (!this.token) throw new Error("not signed in — run `npm run login` first");
    if (this.token.expiresAt - 60_000 <= Date.now()) {
      const fresh = await this.refresh();
      if (!fresh) throw new Error("token refresh failed — sign in again");
      return fresh.accessToken;
    }
    return this.token.accessToken;
  }

  logout(): void {
    this.store.clear();
    this.token = null;
  }

  // ------------------------------------------------------------------
  // Import — reuse an existing Claude Code CLI session instead of a new
  // login. Reads claudeAiOauth from ~/.claude/.credentials.json and stores
  // it in this app's token store; refreshes through the same endpoint.
  // ------------------------------------------------------------------

  importFromClaudeCode(filePath?: string): StoredToken {
    const file =
      filePath ?? path.join(os.homedir(), ".claude", ".credentials.json");
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(
        `cannot read ${file} — is Claude Code installed and logged in? (${(e as Error).message})`,
      );
    }
    const o = raw?.claudeAiOauth;
    if (!o?.accessToken) {
      throw new Error("no claudeAiOauth.accessToken in the credentials file");
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
    this.store.save(t);
    console.log(
      `[auth] imported Claude Code session (expires ${new Date(t.expiresAt).toISOString()})`,
    );
    return t;
  }
}
