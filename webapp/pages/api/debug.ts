import type { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import path from "path";
import { DAPClient } from "../../lib/dapClient";

// Store the DAP session and Python process in module scope so they persist between calls.
let dapClient: DAPClient | null = null;
let pythonProcess: ReturnType<typeof spawn> | null = null;

// Hardcoded target script path (adjust this accordingly)
const targetScript = path.join(process.cwd(), "dap", "test_data", "a.py");

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const { action } = req.query;

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    if (action === "launch") {
      // Launch the target Python process with debugpy.
      const debugpyPort = 5678;
      pythonProcess = spawn("python", [
        "-m",
        "debugpy",
        "--listen",
        `127.0.0.1:${debugpyPort}`,
        "--wait-for-client",
        targetScript,
      ]);
      console.log("Launched Python process with PID:", pythonProcess.pid);

      // Give the Python process time to start and listen.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Create and connect the DAP client.
      dapClient = new DAPClient();
      await dapClient.connect("127.0.0.1", debugpyPort);
      console.log("Connected to DAP server on port", debugpyPort);

      // Listen for messages (for logging).
      dapClient.on("message", (msg) => {
        console.log("<-- Message received:", msg);
      });

      // Perform the sequence: initialize, attach, setBreakpoints, configurationDone.
      const initResp = await dapClient.initialize();
      console.log("Initialize response:", initResp);

      const attachResp = await dapClient.attach("127.0.0.1", debugpyPort);
      console.log("Attach response:", attachResp);

      // Set a breakpoint at line 20 (for example).
      const bpResp = await dapClient.setBreakpoints(targetScript, [
        { line: 20 },
      ]);
      console.log("Breakpoint response:", bpResp);

      const confResp = await dapClient.configurationDone();
      console.log("Configuration done response:", confResp);

      res
        .status(200)
        .json({ success: true, message: "Debug session launched" });
    } else if (action === "evaluate") {
      if (!dapClient) {
        throw new Error("No active DAP session; launch first.");
      }
      const { expression, threadId } = req.body;
      if (!expression) {
        res.status(400).json({ error: "Missing expression in request body" });
        return;
      }
      // Get a stack trace to obtain a frame id.
      const stackResp = await dapClient.stackTrace(threadId || 1);
      let frameId: number | undefined;
      if (
        stackResp.body &&
        stackResp.body.stackFrames &&
        stackResp.body.stackFrames.length > 0
      ) {
        frameId = stackResp.body.stackFrames[0].id;
      }
      const evalResp = await dapClient.evaluate(expression, frameId);
      res.status(200).json({ result: evalResp.body?.result });
    } else if (action === "continue") {
      if (!dapClient) {
        throw new Error("No active DAP session; launch first.");
      }
      const { threadId } = req.body;
      const contResp = await dapClient.continue(threadId || 1);
      res.status(200).json({ result: contResp.body });
    } else {
      res.status(400).json({ error: "Unknown action" });
    }
  } catch (error: any) {
    console.error("Error in debug API:", error);
    res.status(500).json({ error: error.message });
  }
}
