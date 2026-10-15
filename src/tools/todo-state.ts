/**
 * Todo list shared by todo_read / todo_write.
 *
 * Inside a task (see ../context.ts) each task has its own list; outside a
 * task (REPL, tests) a module-level list is used.
 */

import { currentContext } from "../context.js";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

let globalTodos: Todo[] = [];

export const getTodos = (): Todo[] => currentContext()?.todos ?? globalTodos;

export function setTodos(next: Todo[]): void {
  const ctx = currentContext();
  if (ctx) ctx.todos = next;
  else globalTodos = next;
}
