import { tool } from "../tool.js";
import { z } from "zod";
import { getTodos } from "./todo-state.js";

export const todoRead = tool({
  description:
    "Returns the current session task list (todo items with status). Use it to " +
    "recall plan state in long, multi-step work.",
  inputSchema: z.object({}),
  execute: async () => ({ todos: getTodos() }),
});
