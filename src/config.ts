/**
 * OAuth client configuration.
 *
 * No identifiers are hardcoded in the code. The client ID is a public
 * application-registration value (the same for every install of the app it
 * belongs to — it is not tied to you or your machine), but per project policy
 * it is supplied externally:
 *
 *   1. CLAUDE_OAUTH_CLIENT_ID / CLAUDE_OAUTH_AUTHORIZE_URL / … env vars, or
 *   2. a JSON file at CLAUDE_OAUTH_CONFIG or ~/.wrongforge/oauth.json
 *      (create it from oauth.config.example.json — `npm run config:init`).
 *
 * Endpoint URLs and the scope have neutral defaults; only the client ID is
 * mandatory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "./paths.js";

export interface OAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scope: string;
}

export function configFilePath(): string {
  return (
    process.env.CLAUDE_OAUTH_CONFIG ??
    path.join(dataDir(), "oauth.json")
  );
}

/** Returns null when the client ID is not configured (yet). */
export function loadOAuthConfig(): OAuthConfig | null {
  let fileCfg: Partial<OAuthConfig> = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configFilePath(), "utf8"));
  } catch {
    /* optional */
  }

  const clientId = process.env.CLAUDE_OAUTH_CLIENT_ID ?? fileCfg.clientId;
  if (!clientId) return null;

  return {
    clientId,
    authorizeUrl:
      process.env.ANTHROPIC_AUTHORIZE_URL ??
      process.env.CLAUDE_OAUTH_AUTHORIZE_URL ??
      fileCfg.authorizeUrl ??
      "https://console.anthropic.com/oauth/authorize",
    tokenUrl:
      process.env.ANTHROPIC_TOKEN_URL ??
      process.env.CLAUDE_OAUTH_TOKEN_URL ??
      fileCfg.tokenUrl ??
      "https://console.anthropic.com/v1/oauth/token",
    redirectUri:
      process.env.CLAUDE_OAUTH_REDIRECT_URI ??
      fileCfg.redirectUri ??
      "https://console.anthropic.com/oauth/code/callback",
    scope:
      process.env.CLAUDE_OAUTH_SCOPE ??
      fileCfg.scope ??
      "user:inference user:profile",
  };
}

export function configHelp(): string {
  return (
    "OAuth client is not configured. Either set CLAUDE_OAUTH_CLIENT_ID or run\n" +
    "`npm run config:init` to create " +
    configFilePath() +
    " from oauth.config.example.json."
  );
}
