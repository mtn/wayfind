import type { NextApiRequest, NextApiResponse } from "next";
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";

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

    // Call streamText from the AI SDK.
    const result = streamText({
      model: openai("gpt-4-turbo"),
      messages,
    });

    // If the result returns a Node.js stream (i.e. it exposes .pipe),
    // set the proper headers and pipe the output.
    if (typeof (result as any).pipe === "function") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      (result as any).pipe(res);
    }
    // Otherwise, if the result provides a toDataStreamResponse method,
    // convert its ReadableStream to chunks manually and stream them.
    else if (typeof (result as any).toDataStreamResponse === "function") {
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
    }
    // Fallback: if not streaming, then wait for the full text and return it.
    else {
      const text = await result;
      res.status(200).send(text);
    }
  } catch (error: any) {
    console.error("Error processing chat request:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
