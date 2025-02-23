import type { NextApiRequest, NextApiResponse } from "next";

// Declare types for our global state
declare global {
  var debugOutputBuffers: {
    [key: string]: string[];
  };
}

export const config = {
  api: { bodyParser: false },
};

// Initialize a per-session output buffers container on globalThis.
if (!globalThis.debugOutputBuffers) {
  globalThis.debugOutputBuffers = {};
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Expect a token query parameter to identify the session.
  const token =
    typeof req.query.token === "string" ? req.query.token : "default";

  // Ensure an output buffer exists for this session.
  if (!globalThis.debugOutputBuffers[token]) {
    globalThis.debugOutputBuffers[token] = [];
  }
  const outputBuffer = globalThis.debugOutputBuffers[token];

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
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

  // An interval that drains the output buffer (if there were any writes) specific to this session.
  const intervalId = setInterval(() => {
    while (outputBuffer && outputBuffer.length > 0) {
      const output = outputBuffer.shift();
      res.write(`data: ${JSON.stringify(output)}\n\n`);
    }
  }, 100);

  // When the request ends (client disconnect), clean up.
  req.on("close", () => {
    clearInterval(intervalId);
    clearInterval(heartbeat);
    res.end();
  });
}
