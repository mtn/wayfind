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

// This endpoint accepts a POST with a JSON body containing "messages"
// and returns a streaming response from OpenAI.
router.post("/", async (req: Request, res: Response) => {
  console.log("Hit the endpoint");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  try {
    const { messages } = req.body;
    if (!messages) {
      res.status(400).json({ error: "Missing messages in request body" });
      return;
    }

    // Call streamText from the AI SDK with tools and multi-step support.
    const systemPrompt = {
      role: "system",
      content: `You are a highly skilled debugging assistant.
            When you're asked questions about the code, you should always first consider using the debugging tools available to you
            to answer it efficiently and accurately. You have access to the following tools:
            - setBreakpoint: Sets a breakpoint at a given line number.
            - launchDebug: Launches the debugger.
            - continueExecution: Continues execution until the next breakpoint.
            - evaluateExpression: Evaluates an expression at the current execution point.
            Keep in mind that to read the value of a variable, you need to set a breakpoint at least one line _after_ the line that it is
            defined on, otherwise, it'll come back as undefined.
            For example, if the user asks you how the value of a variable changes as the program runs,
            you should use your tools to set breakpoint(s) at lines that let you read the value, launch the program, continue till
            it stops, evaluate it the variable, and so on until it terminates.`,
    };
    const result = streamText({
      model: openai("gpt-4o-mini"),
      messages: [systemPrompt, ...messages],
      tools: {
        setBreakpoint,
        launchDebug,
        continueExecution,
        evaluateExpression,
      },
      maxSteps: 100,
    });

    // Stream the result.
    if (typeof (result as any).pipe === "function") {
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
        res.write(decoder.decode(value));
        read();
      }
      read();
    } else {
      const text = await result;
      res.status(200).send(text);
    }
  } catch (error: any) {
    console.error("Error processing chat request:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

export default router;
