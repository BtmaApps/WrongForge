import { tool } from "../tool.js";
import { z } from "zod";
import { currentContext } from "../context.js";

export const reportProgress = tool({
  description:
    "Sends a short status update to the orchestrator (WrongStack) that is " +
    "supervising this task. Use it at meaningful moments: after you have a plan, " +
    "when you finish a milestone, when you change approach, when you are blocked " +
    "or about to start something long. One or two sentences; say what is done " +
    "and what comes next. It does not stop or pause your work and returns " +
    "immediately. Do not call it for every small step.",
  inputSchema: z.object({
    message: z.string().min(1).max(2000).describe("What is done / what you are doing next"),
    percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Rough overall completion, 0-100 (optional)"),
    phase: z
      .string()
      .max(60)
      .optional()
      .describe("Short phase label, e.g. planning | implementing | verifying | blocked"),
  }),
  execute: async ({ message, percent, phase }) => {
    const ctx = currentContext();
    ctx?.report?.({ message, percent, phase });
    return { ok: true, delivered: Boolean(ctx?.report) };
  },
});
