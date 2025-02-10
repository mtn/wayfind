import type { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import path from "path";
import { DAPClient } from "../../lib/dapClient";

// Store globally so subsequent requests reuse them.
let dapClient: DAPClient | null = null;
let pythonProcess: ReturnType<typeof spawn> | null = null;

// Adjust to match your file structure.
const targetScript = path.join(
  process.cwd(),
  "..",
  "dap",
  "test_scripts",
  "test_data",
  "a.py",
);

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
      // -----------------------------------------------------------------
      // 1) Cleanup any existing session
      // -----------------------------------------------------------------
      if (pythonProcess) {
        pythonProcess.kill();
      }
      if (dapClient) {
        dapClient.close();
      }

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

      // Wait for debugpy to start up
      await new Promise((resolve) => setTimeout(resolve, 1000));

      dapClient = new DAPClient();
      await dapClient.connect("127.0.0.1", debugpyPort);
      console.log("Connected to DAP server on port", debugpyPort);

      // -----------------------------------------------------------------
      // 2) Initialize
      // -----------------------------------------------------------------
      const initResp = await dapClient.initialize();
      console.log("Initialize response:", initResp);

      // -----------------------------------------------------------------
      // 3) Attach (but do NOT call configurationDone yet!)
      // -----------------------------------------------------------------
      await dapClient.attach("127.0.0.1", debugpyPort);
      console.log("Attach sent and initialized event received");

      // Try to get attach response, but don't fail if we don't get it
      try {
        const attachResp = await dapClient.tryGetAttachResponse(2, 1000);
        if (attachResp) {
          console.log("Attach response received:", attachResp);
        }
      } catch (err) {
        console.log("No attach response received (expected in some configs)");
      }

      // -----------------------------------------------------------------
      // DO NOT call configurationDone here. We want to wait
      // until after breakpoints are set.
      // -----------------------------------------------------------------

      res.status(200).json({
        success: true,
        message:
          "Debug session launched. Set breakpoints and then it will run.",
      });
    } else if (action === "setBreakpoints") {
      // -----------------------------------------------------------------
      // 4) Set breakpoints, THEN call configurationDone to let the script run
      // -----------------------------------------------------------------
      if (!dapClient) {
        throw new Error("No active DAP session; launch first.");
      }

      const { breakpoints, filePath } = req.body;
      if (!breakpoints) {
        res.status(400).json({ error: "Missing breakpoints in request body" });
        return;
      }

      // 4a) setBreakpoints
      console.log("Setting breakpoints for script:", targetScript);
      const bpResp = await dapClient.setBreakpoints(targetScript, breakpoints);
      console.log("Breakpoint response:", bpResp);

      // 4b) configurationDone
      console.log("Calling configurationDone so the script can run now...");
      const confResp = await dapClient.configurationDone();
      console.log("configurationDone response:", confResp);

      res
        .status(200)
        .json({ breakpoints: bpResp.body?.breakpoints || [], confResp });
    } else if (action === "evaluate") {
      // no change from your original
      if (!dapClient) {
        throw new Error("No active DAP session; launch first.");
      }
      const { expression, threadId } = req.body;
      if (!expression) {
        res.status(400).json({ error: "Missing expression in request body" });
        return;
      }
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
      // no change from your original
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
