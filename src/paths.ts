/**
 * Per-user data directory (~/.wrongforge): token store, OAuth config, …
 *
 * Renamed from ~/.wrongminiagent when the project became WrongForge. On first
 * use, if the new directory does not exist but the legacy one does, its
 * contents are COPIED over (the legacy directory is left untouched), so an
 * existing `npm run import` session and config keep working.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const APP_NAME = "WrongForge";
const DIR_NAME = ".wrongforge";
const LEGACY_DIR_NAME = ".wrongminiagent";

let resolved: string | null = null;

/** Data directory. `WRONGFORGE_HOME` overrides the location. */
export function dataDir(): string {
  if (process.env.WRONGFORGE_HOME) return process.env.WRONGFORGE_HOME;
  if (resolved) return resolved;

  const dir = path.join(os.homedir(), DIR_NAME);
  const legacy = path.join(os.homedir(), LEGACY_DIR_NAME);
  resolved = dir;
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    try {
      fs.cpSync(legacy, dir, { recursive: true });
      console.error(`[${APP_NAME}] copied ${legacy} -> ${dir} (the old directory was left in place)`);
    } catch (e) {
      // could not migrate: keep working with the old location rather than lose the session
      console.error(`[${APP_NAME}] could not migrate ${legacy}: ${(e as Error).message} — using the old directory`);
      resolved = legacy;
    }
  }
  return resolved;
}
