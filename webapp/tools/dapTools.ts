import { tool } from "ai";
import { z } from "zod";

export const setBreakpoint = tool({
  description:
    "Set a breakpoint at a given line number in a.py. (Client‑side tool)",
  parameters: z.object({
    line: z.number().describe("The line where the breakpoint should be set"),
    // hardcoding filePath via a literal ensures that even if a filePath is provided,
    // it must be exactly "a.py".
    filePath: z.literal("a.py"),
  }),
  // Notice: No "execute" function is provided.
});
