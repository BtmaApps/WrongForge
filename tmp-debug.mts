import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { McpStore } from "./src/mcp/config.js";
import { McpRegistry } from "./src/mcp/registry.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-"));
const reg = new McpRegistry({ store: new McpStore(path.join(tmp, "m.json")), env: {} });
reg.addServer("local", { command: process.execPath, args: [path.resolve("test/fixtures/mini-mcp.mjs"), "stdio"] });
const r = await reg.test("local");
console.log(JSON.stringify(r, null, 2));
await reg.closeAll();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
