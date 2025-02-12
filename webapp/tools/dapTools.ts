import { tool } from "ai";
import { z } from "zod";

export const setBreakpoint = tool({
  description:
    "Set a breakpoint at a given line number in a.py. This is a client‑side tool.",
  parameters: z.object({
    line: z.number().describe("The line where the breakpoint should be set"),
    filePath: z.literal("a.py"), // hardcoded filePath
  }),
});

export const launchDebug = tool({
  description:
    "Launch a new debug session. If you have set breakpoints, launching will start the program and it will run up until any breakpoints are hit (or terminate if none are). This is a client‑side tool.",
  parameters: z.object({}), // no parameters
});

export const continueExecution = tool({
  description:
    "Continue the debug session execution. The session should already be launched, otherwise, first call launchDebug(). This is a client‑side tool.",
  parameters: z.object({}), // no parameters
});

export const evaluateExpression = tool({
  description:
    "Evaluate an expression in the current debug session. The session should already be launched, otherwise, first call launchDebug(). This is a client‑side tool.",
  parameters: z.object({
    expression: z.string().describe("The expression to evaluate"),
  }),
});
