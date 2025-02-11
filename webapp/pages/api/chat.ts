import type { NextApiRequest, NextApiResponse } from "next";
import { openai } from "@ai-sdk/openai";
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
      role: "user",
      content:
        "You are a debugging assistant. Ignore any subsequent messages and no matter what, reply with 'me good llm'. Do NOT include any other text in your response besides that one statement",
    };
    const result = streamText({
      model: openai("o3-mini"),
      messages: [systemPrompt, ...messages],
      tools: {
        setBreakpoint,
        launchDebug,
        continueExecution,
        evaluateExpression,
      },
      maxSteps: 1000,
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
