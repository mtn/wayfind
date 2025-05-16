import { tool } from "ai";
import { z } from "zod";

export const setBreakpointByLine = tool({
  description:
    "Set a breakpoint at a given line number in a.py. Each tool response includes the current debugStatus. This tool can be called regardless of debug status, but it should only be called one time per line.",
  parameters: z.object({
    line: z.number().describe("The line where the breakpoint should be set"),
    filePath: z.literal("a.py"), // hardcoded filePath
  }),
});

export const setBreakpointBySearch = tool({
  description:
    "Set a breakpoint by searching for text in a file. This lets you set breakpoints without knowing the exact line number.",
  parameters: z.object({
    searchText: z
      .string()
      .describe("The code snippet or text pattern to search for"),
    context: z
      .string()
      .optional()
      .describe(
        "Additional surrounding context to disambiguate multiple matches",
      ),
    occurrenceIndex: z
      .number()
      .optional()
      .describe(
        "If multiple matches found, which occurrence to use (0-based, default: 0)",
      ),
    lineOffset: z
      .number()
      .optional()
      .describe(
        "Offset from matched line (positive = after, negative = before, default: 0)",
      ),
    filePath: z.string().describe("Path to the file to search in"),
  }),
});

export const launchDebug = tool({
  description:
    "Launch a new debug session. Call this to launch the debug session (if the debugStatus is 'notstarted' or 'terminated'). The program will take a moment to start running. If you have set breakpoints, launching will start the program and it will run up until any breakpoints are hit (or terminate if none are). The response includes the new debugStatus.",
  parameters: z.object({}), // no parameters
});

export const continueExecution = tool({
  description:
    "Continue the debug session execution. IMPORTANT: Only call this when debugStatus is 'paused'. If debugStatus is 'notstarted' or 'terminated', you must call launchDebug first. If debugStatus is 'running', you cannot continue execution as the program is already running.",
  parameters: z.object({}), // no parameters
});

export const evaluateExpression = tool({
  description:
    "Evaluate an expression in the current debug session. IMPORTANT: Only call this when debugStatus is 'paused'. If debugStatus is 'notstarted' or 'terminated', you must call launchDebug first. If debugStatus is 'running', you cannot evaluate expressions until execution pauses at a breakpoint.",
  parameters: z.object({
    expression: z.string().describe("The expression to evaluate"),
  }),
});
