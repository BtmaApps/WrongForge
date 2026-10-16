/**
 * System prompt assembly for task mode.
 *
 *   base prompt (agent.ts)
 *   + "task mode" block (worker role, cwd, progress reporting, no interactivity)
 *   + every  <prompt dir>/*.md   (sorted; files starting with "_" or named README.md are skipped)
 *   + the task's own `system_append`
 *
 * The prompt dir is where tool guides live — e.g. how to drive the WrongStack
 * CLI through `bash`. It is re-read for every task, so edits apply without a
 * server restart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SYSTEM_PROMPT } from "./agent.js";
import { EMBEDDED_PROMPTS } from "./embedded-webui.js";

/** Default prompt directory: `WRONGFORGE_PROMPT_DIR` or `<repo>/prompts`. */
export function promptDir(): string {
  return process.env.WRONGFORGE_PROMPT_DIR || path.join(import.meta.dirname ?? ".", "..", "prompts");
}

export interface PromptFile {
  name: string;
  content: string;
}

/**
 * Reads the guide files; a missing directory simply yields none. Guides
 * embedded in the compiled binary are appended when the disk does not have
 * a file of the same name (disk wins), so a checkout and a bare executable
 * see the same defaults.
 */
export function loadPromptFiles(dir: string = promptDir()): PromptFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const files: PromptFile[] = names
    .filter((n) => n.endsWith(".md") && !n.startsWith("_") && n.toLowerCase() !== "readme.md")
    .sort()
    .map((name) => {
      try {
        return { name, content: fs.readFileSync(path.join(dir, name), "utf8").trim() };
      } catch {
        return { name, content: "" };
      }
    })
    .filter((f) => f.content.length > 0);
  for (const [name, content] of Object.entries(EMBEDDED_PROMPTS)) {
    if (content.trim() && !names.includes(name)) files.push({ name, content: content.trim() });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

export interface TaskPromptInput {
  systemAppend?: string;
  /** Override the guide directory (tests). */
  promptDir?: string;
}

/**
 * Per-task facts (task id, cwd) go at the START OF THE USER MESSAGE, not into
 * the system prompt: the system prompt is part of the cached prefix, so
 * anything that changes per task in there would invalidate the prompt cache
 * of the whole session on every task.
 */
export function buildTaskPreamble(input: { taskId: string; cwd: string }): string {
  return [
    "<task_context>",
    `task_id: ${input.taskId}`,
    `working_directory: ${input.cwd}`,
    "</task_context>",
  ].join("\n");
}

/**
 * Stable by design: contains NO ids, paths or timestamps. It only changes
 * when a guide file or `system_append` changes — and then the session's
 * prompt cache starts over.
 */
export function buildTaskSystemPrompt(input: TaskPromptInput = {}): string {
  const parts: string[] = [SYSTEM_PROMPT];

  parts.push(
    [
      "## Task mode — you are a worker for the WrongStack orchestrator",
      "",
      "You were started by WrongStack to complete ONE task. Each task message begins with a <task_context> block giving the task id and the absolute working directory.",
      "",
      "Rules for this mode (they override the general principles above where they conflict):",
      "- Nobody answers questions interactively. Never wait for confirmation. Make a reasonable assumption and say so, or — if you truly cannot continue — stop and explain the blocker.",
      "- Do not run destructive or hard-to-reverse actions (deleting data, force-push, dependency installs outside the task scope) unless the task explicitly asks for them; otherwise report it as a blocker.",
      "- Keep the orchestrator informed with `report_progress`: once after you have a plan, at each milestone, when you change approach, and when you are blocked. Keep each update to one or two sentences.",
      "- Keep your todo list (`todo_write`) current for multi-step work; the orchestrator sees it.",
      "- Your FINAL message is delivered to the orchestrator as the task result. Make it self-contained: what you did, which files you changed or created, how you verified it, and anything left undone or uncertain. State clearly if the task could not be completed and why.",
    ].join("\n"),
  );

  for (const f of loadPromptFiles(input.promptDir)) {
    parts.push(`## Guide: ${f.name.replace(/\.md$/, "")}\n\n${f.content}`);
  }

  if (input.systemAppend?.trim()) {
    parts.push(`## Additional instructions for this task\n\n${input.systemAppend.trim()}`);
  }

  return parts.join("\n\n");
}
