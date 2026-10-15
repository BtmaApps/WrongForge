/**
 * MCP server management from the terminal.
 *
 *   npm run mcp -- list
 *   npm run mcp -- add github --url https://api.githubcopilot.com/mcp/ --header "Authorization=Bearer \${GITHUB_TOKEN}"
 *   npm run mcp -- add fs --command npx -- -y @modelcontextprotocol/server-filesystem D:/work
 *   npm run mcp -- test github
 *   npm run mcp -- tools github [tool]
 *   npm run mcp -- call github search_repositories '{"query":"wrongforge"}'
 *   npm run mcp -- import ~/.claude.json
 *
 * Changes are written to the config file and picked up by a running server on
 * its next use — no restart needed.
 */

import * as fs from "node:fs";
import { McpConfigError, McpStore, redactSpec } from "./mcp/config.js";
import { McpRegistry } from "./mcp/registry.js";

const HELP = `WrongForge MCP servers

Usage: npm run mcp -- <command> [options]

  list                          show configured servers
  add <name> --url <url>        add an HTTP (default) or SSE server
        [--type http|sse] [--header "Name=Value"]...
  add <name> --command <cmd>    add a local stdio server; arguments go after "--"
        [--env "NAME=value"]... [--cwd <dir>]   e.g.  add fs --command npx -- -y @modelcontextprotocol/server-filesystem D:/work
  add-json <name> '<json>'      add from a JSON entry
  import <file> [--overwrite]   import a Claude Code / Claude Desktop style config ({ "mcpServers": {…} })
  remove <name>                 delete a server
  enable <name> | disable <name>
  test <name>                   connect and list the tools
  tools <name> [tool]           list tools, or show one tool's input schema
  call <name> <tool> '<json>'   call a tool once
  path                          print the config file location

Options for add / add-json / import:
  --description <text>   --eager true|false   --required true|false
  --allow a,b*           --deny c,d*          --timeout <ms>
Global:  --json (machine-readable output)

Tip: reference secrets as \${ENV_VAR} (e.g. --header "Authorization=Bearer \${TOKEN}") so the config file holds no secret.
`;

interface Parsed {
  cmd: string;
  pos: string[];
  rest: string[];
  flags: Map<string, string[]>;
}

const BOOL_FLAGS = new Set(["json", "overwrite", "help"]);

function parse(argv: string[]): Parsed {
  const flags = new Map<string, string[]>();
  const pos: string[] = [];
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      let name = key;
      let value: string | undefined;
      if (eq > 0 && !BOOL_FLAGS.has(key.slice(0, eq))) {
        name = key.slice(0, eq);
        value = key.slice(eq + 1);
      } else if (!BOOL_FLAGS.has(key)) {
        value = argv[++i];
        if (value === undefined) throw new McpConfigError(`--${key} needs a value`);
      }
      flags.set(name, [...(flags.get(name) ?? []), value ?? "true"]);
    } else {
      pos.push(a);
    }
  }
  return { cmd: pos[0] ?? "help", pos: pos.slice(1), rest, flags };
}

const one = (p: Parsed, name: string): string | undefined => p.flags.get(name)?.at(-1);
const many = (p: Parsed, name: string): string[] => p.flags.get(name) ?? [];

function kv(items: string[], what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    const i = it.indexOf("=");
    const j = it.indexOf(": ");
    const cut = i > 0 && (j < 0 || i < j) ? i : j;
    if (cut <= 0) throw new McpConfigError(`${what} "${it}" must look like Name=Value`);
    out[it.slice(0, cut).trim()] = it.slice(cut + (cut === j ? 2 : 1)).trim();
  }
  return out;
}

const bool = (v: string | undefined, name: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (/^(true|yes|1)$/i.test(v)) return true;
  if (/^(false|no|0)$/i.test(v)) return false;
  throw new McpConfigError(`--${name} must be true or false`);
};

/** Flags shared by add / add-json / import. */
function extras(p: Parsed): Record<string, unknown> {
  const e: Record<string, unknown> = {};
  if (one(p, "description")) e.description = one(p, "description");
  const eager = bool(one(p, "eager"), "eager");
  if (eager !== undefined) e.eager = eager;
  const required = bool(one(p, "required"), "required");
  if (required !== undefined) e.required = required;
  if (one(p, "allow")) e.allow = one(p, "allow")!.split(",").map((s) => s.trim()).filter(Boolean);
  if (one(p, "deny")) e.deny = one(p, "deny")!.split(",").map((s) => s.trim()).filter(Boolean);
  if (one(p, "timeout")) e.timeout_ms = Number(one(p, "timeout"));
  return e;
}

function target(s: { type: string; url?: string; command?: string; args?: string[] }): string {
  return s.type === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : (s.url ?? "");
}

async function main(): Promise<number> {
  const p = parse(process.argv.slice(2));
  const json = p.flags.has("json");
  if (p.cmd === "help" || p.flags.has("help")) {
    console.log(HELP);
    return 0;
  }

  const store = new McpStore(McpStore.defaultFile());
  const reg = new McpRegistry({ store });
  const out = (human: string, data: unknown): void => console.log(json ? JSON.stringify(data, null, 2) : human);
  const need = (i: number, what: string): string => {
    const v = p.pos[i];
    if (!v) throw new McpConfigError(`missing <${what}> — run "npm run mcp -- help"`);
    return v;
  };

  try {
    switch (p.cmd) {
      case "path":
        out(store.file, { file: store.file });
        return 0;

      case "list": {
        const s = reg.status();
        if (json) return void console.log(JSON.stringify(s, null, 2)), 0;
        if (!s.servers.length) console.log(`No MCP servers configured yet.\nAdd one:  npm run mcp -- add <name> --url <url>   (config file: ${s.file})`);
        for (const x of s.servers) {
          const flags = [x.spec.enabled === false ? "disabled" : "enabled", x.spec.eager === false ? "lazy" : "eager", x.spec.required ? "required" : ""].filter(Boolean).join(", ");
          console.log(`${x.name}  [${x.spec.type}; ${flags}]\n    ${target(x.spec as never)}${x.spec.description ? `\n    ${x.spec.description}` : ""}`);
        }
        for (const e of s.errors) console.log(`! invalid entry: ${e.error}`);
        return 0;
      }

      case "add": {
        const name = need(0, "name");
        const spec: Record<string, unknown> = { ...extras(p) };
        if (one(p, "command")) {
          spec.type = "stdio";
          spec.command = one(p, "command");
          const args = [...many(p, "arg"), ...p.rest];
          if (args.length) spec.args = args;
          if (p.flags.has("env")) spec.env = kv(many(p, "env"), "--env");
          if (one(p, "cwd")) spec.cwd = one(p, "cwd");
        } else if (one(p, "url")) {
          spec.type = one(p, "type") ?? "http";
          spec.url = one(p, "url");
          if (p.flags.has("header")) spec.headers = kv(many(p, "header"), "--header");
        } else {
          throw new McpConfigError("give --url <url> (remote server) or --command <cmd> (local server)");
        }
        const r = reg.addServer(name, spec);
        out(`${r.existed ? "Updated" : "Added"} "${name}" (${r.spec.type}) in ${store.file}\nCheck it:  npm run mcp -- test ${name}`, { name, existed: r.existed, spec: redactSpec(r.spec) });
        return 0;
      }

      case "add-json": {
        const name = need(0, "name");
        let entry: unknown;
        try {
          entry = JSON.parse(need(1, "json"));
        } catch (e) {
          throw new McpConfigError(`the JSON is not valid: ${(e as Error).message}`);
        }
        const r = reg.addServer(name, { ...(entry as object), ...extras(p) });
        out(`${r.existed ? "Updated" : "Added"} "${name}" (${r.spec.type})`, { name, existed: r.existed });
        return 0;
      }

      case "import": {
        const file = need(0, "file");
        let doc: unknown;
        try {
          doc = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
          throw new McpConfigError(`cannot read ${file}: ${(e as Error).message}`);
        }
        const r = reg.importServers(doc, { overwrite: p.flags.has("overwrite") });
        out(
          `added: ${r.added.join(", ") || "-"}\nupdated: ${r.updated.join(", ") || "-"}\nskipped (already exist; use --overwrite): ${r.skipped.join(", ") || "-"}` +
            (r.invalid.length ? `\ninvalid:\n${r.invalid.map((i) => `  ${i.name}: ${i.error}`).join("\n")}` : ""),
          r,
        );
        return r.invalid.length && !r.added.length && !r.updated.length ? 1 : 0;
      }

      case "remove": {
        const name = need(0, "name");
        const ok = reg.removeServer(name);
        out(ok ? `Removed "${name}".` : `No server named "${name}".`, { removed: ok });
        return ok ? 0 : 1;
      }

      case "enable":
      case "disable": {
        const name = need(0, "name");
        const r = reg.setEnabled(name, p.cmd === "enable");
        out(r ? `${p.cmd === "enable" ? "Enabled" : "Disabled"} "${name}".` : `No server named "${name}".`, { ok: Boolean(r) });
        return r ? 0 : 1;
      }

      case "test": {
        const name = need(0, "name");
        const t = await reg.test(name);
        if (json) return void console.log(JSON.stringify(t, null, 2)), t.ok ? 0 : 1;
        if (!t.ok) {
          console.log(`✗ ${name}: ${t.error}`);
          return 1;
        }
        console.log(`✓ ${name} — ${t.server_info?.name ?? "server"} ${t.server_info?.version ?? ""} (${t.duration_ms} ms), ${t.tools.length} tool(s):`);
        for (const x of t.tools) console.log(`    ${x.name}  ${x.description}`);
        if (t.instructions) console.log(`\nServer instructions:\n${t.instructions}`);
        return 0;
      }

      case "tools": {
        const name = need(0, "name");
        const defs = await reg.listTools(name, { refresh: true });
        const only = p.pos[1];
        if (only) {
          const d = defs.find((x) => x.name === only);
          if (!d) throw new McpConfigError(`"${name}" has no tool "${only}" (it has: ${defs.map((x) => x.name).join(", ")})`);
          out(`${d.name}\n${d.description}\n\n${JSON.stringify(d.schema, null, 2)}`, d);
        } else {
          out(defs.map((d) => `${d.name}  ${d.description.split("\n")[0]!.slice(0, 100)}`).join("\n"), defs);
        }
        return 0;
      }

      case "call": {
        const name = need(0, "name");
        const tool = need(1, "tool");
        let input: unknown = {};
        if (p.pos[2]) {
          try {
            input = JSON.parse(p.pos[2]);
          } catch (e) {
            throw new McpConfigError(`the input is not valid JSON: ${(e as Error).message}`);
          }
        }
        const r = await reg.callTool(name, tool, input);
        out(r.ok ? String(r.output ?? JSON.stringify(r)) : `error: ${String(r.error)}`, r);
        return r.ok ? 0 : 1;
      }

      default:
        console.error(`unknown command "${p.cmd}"\n`);
        console.log(HELP);
        return 2;
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  } finally {
    await reg.closeAll();
  }
}

main().then((code) => process.exit(code));
