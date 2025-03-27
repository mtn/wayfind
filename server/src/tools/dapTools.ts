import { tool } from "ai";
import { z } from "zod";

export const setBreakpoint = tool({
  description:
    "Set a breakpoint at a given line number in a.py. Each tool response includes the current debugStatus. This tool can be called regardless of debug status.",
  parameters: z.object({
    line: z.number().describe("The line where the breakpoint should be set"),
    filePath: z.literal("a.py"), // hardcoded filePath
  }),
});

export const launchDebug = tool({
  description:
    "Launch a new debug session. Call this once to launch the debug session (if the debugStatus is 'notstarted' or 'terminated'), then wait for the program to start before calling it again. If you have set breakpoints, launching will start the program and it will run up until any breakpoints are hit (or terminate if none are). The response includes the new debugStatus.",
  parameters: z.object({}), // no parameters
});

export const continueExecution = tool({
  description:
    "Continue the debug session execution. IMPORTANT: Only call this when debugStatus is 'paused'. If debugStatus is 'notstarted' or 'terminated', you must call launchDebug first -- but only if you haven't called it yet. If debugStatus is 'running', you cannot continue execution as the program is already running.",
  parameters: z.object({}), // no parameters
});

export const evaluateExpression = tool({
  description:
    "Evaluate an expression in the current debug session. IMPORTANT: Only call this when debugStatus is 'paused'. If debugStatus is 'notstarted' or 'terminated', you must call launchDebug first -- but only if you haven't called it yet. If debugStatus is 'running', you cannot evaluate expressions until execution pauses at a breakpoint.",
  parameters: z.object({
    expression: z.string().describe("The expression to evaluate"),
  }),
});
