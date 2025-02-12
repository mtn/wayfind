import type { NextApiRequest, NextApiResponse } from "next";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import {
  setBreakpoint,
  launchDebug,
  continueExecution,
  evaluateExpression,
} from "@/tools/dapTools";

// This endpoint accepts a POST with a JSON body containing "messages"
// and returns a streaming response from OpenAI.
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
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
        it stops, evaluate it the variable, and so on until it terminates.
        Using the tools is STRICTLY PREFERRED to inspecting the code for answering this type of question.
        If the user makes a request like this, YOU MUST USE THE DEBUGGING TOOLS.`,
    };
    const result = streamText({
      model: anthropic("claude-3-5-sonnet-latest"),
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
}
