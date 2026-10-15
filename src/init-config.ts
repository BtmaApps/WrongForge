/**
 * Copies oauth.config.example.json to the user config location
 * (~/.wrongforge/oauth.json) so no client identifiers live in the code.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "./paths.js";

const dest = path.join(dataDir(), "oauth.json");
const src = path.join(import.meta.dirname ?? ".", "..", "oauth.config.example.json");

fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) {
  console.log(`config already exists: ${dest}`);
} else {
  fs.copyFileSync(src, dest);
  console.log(`wrote ${dest}`);
}
