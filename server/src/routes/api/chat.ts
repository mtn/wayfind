import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
const debug = process.env.DEBUG_CHAT === "true";

import { Router, Request, Response } from "express";
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import {
  setBreakpoint,
  launchDebug,
  continueExecution,
  evaluateExpression,
} from "@/tools/dapTools";

const router = Router();

interface ToolCall {
  toolName: string;
  timestamp: number;
}

type DebugTools = {
  setBreakpoint: typeof setBreakpoint;
  launchDebug?: typeof launchDebug;
  continueExecution?: typeof continueExecution;
  evaluateExpression?: typeof evaluateExpression;
};

const toolDescriptions: Record<string, string> = {
  setBreakpoint: "Sets a breakpoint at a given line number",
  launchDebug: "Launches the debugger",
  continueExecution: "Continues execution until the next breakpoint",
  evaluateExpression: "Evaluates an expression at the current execution point",
};

function getToolsForDebugStatus(debugStatus: string): DebugTools {
  const baseTools = { setBreakpoint };
  switch (debugStatus) {
    case "notstarted":
    case "terminated":
      return { ...baseTools, launchDebug };
    case "paused":
      return {
        ...baseTools,
        continueExecution,
        evaluateExpression,
      };
    case "running":
      return baseTools;
    default:
      return baseTools;
  }
}

router.post("/", async (req: Request, res: Response) => {
  console.log("Hit the endpoint");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  try {
    const { messages, debugState } = req.body;
    if (!messages) {
      res.status(400).json({ error: "Missing messages in request body" });
      return;
    }

    if (debug) {
      console.log("Incoming messages:", JSON.stringify(messages, null, 2));
    }

    const debugStatus = debugState?.debugStatus ?? "notstarted";
    const toolCallLog = debugState?.toolCallLog ?? [];
    const wasLaunchDebugRecentlyCalled = toolCallLog.some(
      (call: ToolCall) =>
        call.toolName === "launchDebug" && Date.now() - call.timestamp < 5000,
    ); // within last 5 seconds

    const tools = getToolsForDebugStatus(debugStatus);

    if (wasLaunchDebugRecentlyCalled && "launchDebug" in tools) {
      delete tools.launchDebug;
    }

    const systemPrompt = {
      role: "system",
      content: `You are a highly skilled debugging assistant.
            When you're asked questions about the code, you should always first consider using the debugging tools available to you
            to answer it efficiently and accurately. You have access to the following tools:
            ${Object.keys(tools)
              .map((tool) => `- ${tool}: ${toolDescriptions[tool]}`)
              .join("\n            ")}

            Current debug status: ${debugStatus}
            Current datetime: ${new Date().toISOString()}

            Keep in mind that to read the value of a variable, you need to set a breakpoint at least one line _after_ the line that it is
            defined on, otherwise, it'll come back as undefined.
            For example, if the user asks you how the value of a variable changes as the program runs,
            you should use your tools to set breakpoint(s) at lines that let you read the value, launch the program, continue till
            it stops, evaluate the variable, and so on until it terminates.

            If you can't complete the task in the available number of steps, that's alright, just start it and thenyou'll be given more
            steps to finish..`,
    };

    const result = streamText({
      model: openai("gpt-4o-mini"),
      messages: [systemPrompt, ...messages],
      tools,
      maxSteps: 5,
    });

    // Stream the result.
    if (typeof (result as any).pipe === "function") {
      if (debug && typeof (result as any).on === "function") {
        (result as any).on("data", (chunk: Buffer) => {
          const chunkStr = chunk.toString();
          console.log("Stream chunk:", chunkStr);
          if (chunkStr.includes('"toolName"')) {
            console.log("Tool call chunk detected:", chunkStr);
          }
        });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      (result as any).pipe(res);
    } else if (typeof (result as any).toDataStreamResponse === "function") {
      const response = (result as any).toDataStreamResponse();
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      async function read() {
        if (!reader) return;
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        const decoded = decoder.decode(value);
        if (debug) {
          console.log("Stream chunk:", decoded);
          if (decoded.includes('"toolName"')) {
            console.log("Tool call chunk detected:", decoded);
          }
        }
        res.write(decoded);
        read();
      }
      read();
    } else {
      const text = result;
      res.status(200).send(text);
    }
  } catch (error: any) {
    console.error("Error processing chat request:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

export default router;
