/**
 * Agent tools — a detailed collection mirroring Claude Code's built-ins.
 * One file per tool; shared helpers live in util / glob-utils / shell /
 * web-utils.
 *
 *   bash        run a shell command (cwd, timeout, process-tree kill)
 *   read        read a file with numbered lines (offset/limit)
 *   write       write a file (creates parents)
 *   edit        exact string replacement (must be unique, or replace_all)
 *   ls          list a directory
 *   glob        find files by glob pattern (**, *, ?, [], {a,b}), newest first
 *   grep        search file contents by regex (content / files / count modes)
 *   web_fetch   fetch a URL and return readable text
 *   todo_read   read the session task list
 *   todo_write  replace the session task list
 *   report_progress  status update to the orchestrator (WrongStack) — task mode
 *
 * All local tools run on the user's machine in the working directory.
 * Nothing machine-specific is transmitted (see README privacy section).
 *
 * Every tool returns a plain object with `ok` and, on failure, an `error`
 * string written so the model can fix its next call (it says what went wrong
 * and what to try instead).
 */

import { bash } from "./bash.js";
import { read } from "./read.js";
import { write } from "./write.js";
import { edit } from "./edit.js";
import { ls } from "./ls.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { web_fetch } from "./web-fetch.js";
import { todoRead } from "./todo-read.js";
import { todoWrite } from "./todo-write.js";
import { reportProgress } from "./report-progress.js";
import { mcpServers, mcpAdd, mcpRemove, mcpTools, mcpCall } from "./mcp-tools.js";

export const agentTools = {
  bash,
  read,
  write,
  edit,
  ls,
  glob,
  grep,
  web_fetch,
  todo_read: todoRead,
  todo_write: todoWrite,
  report_progress: reportProgress,
  mcp_servers: mcpServers,
  mcp_add: mcpAdd,
  mcp_remove: mcpRemove,
  mcp_tools: mcpTools,
  mcp_call: mcpCall,
};

// helpers re-exported for tests and other modules
export { compileGlob, expandBraces, globToRegExp } from "./glob-utils.js";
export { htmlToText, isPrivateAddress } from "./web-utils.js";
export { truncateMiddle } from "./util.js";
export type { Todo } from "./todo-state.js";
