import { tool } from "ai";
import { z } from "zod";
import { setTodos, type Todo } from "./todo-state.js";

export const todoWrite = tool({
  description:
    "Replaces the session task list. Use it when starting multi-step work: " +
    "record the plan as todo items, mark the current item in_progress, and " +
    "mark items completed as you finish them. At most one item may be " +
    "in_progress at a time. Pass an empty list to clear it. This is the source " +
    "of truth for plan state.",
  inputSchema: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().min(1).describe("Short imperative description of the task"),
          status: z.enum(["pending", "in_progress", "completed"]),
          activeForm: z
            .string()
            .optional()
            .describe("Present-progressive form, e.g. 'Running tests'"),
        }),
      )
      .describe("The full task list (replaces the previous one)"),
  }),
  execute: async ({ todos: t }) => {
    const inProgress = t.filter((x: Todo) => x.status === "in_progress").length;
    if (inProgress > 1) {
      return {
        ok: false,
        error: `at most one todo item may be in_progress (got ${inProgress}) — mark the others pending or completed`,
      };
    }
    setTodos(t);
    const completed = t.filter((x: Todo) => x.status === "completed").length;
    return {
      ok: true,
      count: t.length,
      completed,
      inProgress,
      pending: t.length - completed - inProgress,
    };
  },
});
