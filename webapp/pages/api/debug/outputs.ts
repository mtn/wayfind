import type { NextApiRequest, NextApiResponse } from "next";
import { sessionManager } from "@/lib/SessionManager";

export const config = {
  api: { bodyParser: false },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const sessionId = req.headers["x-session-id"] as string;

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!sessionId) {
    res.status(401).json({ error: "Missing session ID" });
    return;
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    res.status(403).json({ error: "Invalid session ID" });
    return;
  }

  // Set up SSE headers including one to disable buffering.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disables proxy buffering (e.g. for Nginx)
  });

  // (If available) Disable socket timeout and disable Nagle's algorithm.
  if (res.socket) {
    res.socket.setTimeout(0);
    res.socket.setNoDelay(true);
  }

  // Flush headers immediately.
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  // Heartbeat to keep the connection alive every 15 seconds.
  const heartbeat = setInterval(() => {
    res.write(":\n\n"); // SSE comment heartbeat line
  }, 15000);

  // An interval that drains the output buffer (if there were any writes).
  const intervalId = setInterval(() => {
    while (session.outputBuffer.length > 0) {
      const output = session.outputBuffer.shift();
      if (output) {
        res.write(`data: ${JSON.stringify(output)}\n\n`);
      }
    }
  }, 100);

  // When the request ends (client disconnect), clean up.
  req.on("close", () => {
    clearInterval(intervalId);
    clearInterval(heartbeat);
    res.end();
  });
}
