import type { NextApiRequest, NextApiResponse } from "next";

// Ensure our global buffer exists.
if (!globalThis.debugOutputBuffer) {
  globalThis.debugOutputBuffer = [];
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // Get the current buffered output.
  const output = globalThis.debugOutputBuffer;
  // Clear the buffer so that subsequent requests return only new output.
  globalThis.debugOutputBuffer = [];
  res.status(200).json({ output });
}
