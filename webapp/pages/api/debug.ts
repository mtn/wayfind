import type { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import path from "path";
import { DAPClient } from "../../lib/dapClient";

// Declare globals so that the DAPClient, pythonProcess, and configuration flag
// persist between requests.
declare global {
  // Use symbols on globalThis to avoid collisions.
  var dapClient: DAPClient | null | undefined;
  var pythonProcess: ReturnType<typeof spawn> | null | undefined;
  var configurationDoneSent: boolean | undefined;
}

// Initialize globals if they don’t exist
if (globalThis.dapClient === undefined) {
  globalThis.dapClient = null;
}
if (globalThis.pythonProcess === undefined) {
  globalThis.pythonProcess = null;
}
if (globalThis.configurationDoneSent === undefined) {
  globalThis.configurationDoneSent = false;
}

let dapClient: DAPClient | null = globalThis.dapClient;
let pythonProcess: ReturnType<typeof spawn> | null = globalThis.pythonProcess;
let configurationDoneSent: boolean = globalThis.configurationDoneSent;

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
  if (req.method !== "POST" && action !== "status") {
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
      // Reset our configurationDone flag for a new session.
      configurationDoneSent = false;
      globalThis.configurationDoneSent = false;

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

      // Save these instances to the global context.
      globalThis.dapClient = dapClient;
      globalThis.pythonProcess = pythonProcess;

      // -----------------------------------------------------------------
      // 2) Initialize debugger adapter
      // -----------------------------------------------------------------
      const initResp = await dapClient.initialize();
      console.log("Initialize response:", initResp);

      // -----------------------------------------------------------------
      // 3) Attach (but do NOT call configurationDone yet!)
      // -----------------------------------------------------------------
      await dapClient.attach("127.0.0.1", debugpyPort);
      console.log("Attach sent and initialized event received");

      res.status(200).json({
        success: true,
        message:
          "Debug session launched. Set breakpoints if desired, or press continue to run the program.",
      });
    } else if (action === "setBreakpoints") {
      // -----------------------------------------------------------------
      // 4) Set breakpoints, THEN call configurationDone so the script runs
      // -----------------------------------------------------------------
      if (!dapClient) {
        throw new Error("No active DAP session; launch first.");
      }
      const { breakpoints } = req.body;
      if (!breakpoints) {
        res.status(400).json({ error: "Missing breakpoints in request body" });
        return;
      }
      console.log("Setting breakpoints for script:", targetScript);
      const bpResp = await dapClient.setBreakpoints(targetScript, breakpoints);
      console.log("Breakpoint response:", bpResp);
      console.log("Calling configurationDone so the script can run now...");
      const confResp = await dapClient.configurationDone();
      console.log("configurationDone response:", confResp);
      configurationDoneSent = true;
      globalThis.configurationDoneSent = true;
      res.status(200).json({
        breakpoints: bpResp.body?.breakpoints || [],
        confResp,
      });
    } else if (action === "evaluate") {
      // -----------------------------------------------------------------
      // Evaluate an expression
      // -----------------------------------------------------------------
      if (!dapClient) {
        throw new Error("No active DAP session; launch first.");
      }
      const { expression, threadId } = req.body;
      if (!expression) {
        res.status(400).json({ error: "Missing expression in request body" });
        return;
      }
      const effectiveThreadId =
        threadId || (dapClient.currentPausedLocation ? 1 : 1);
      const stackResp = await dapClient.stackTrace(effectiveThreadId);
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
      // -----------------------------------------------------------------
      // Continue execution
      // -----------------------------------------------------------------
      if (!dapClient) {
        throw new Error("No active DAP session; launch first.");
      }
      // If configurationDone has not been sent yet, try to send it.
      // If we get an error indicating that configurationDone is only allowed during
      // a launch/attach request, then assume configuration is already complete.
      if (!configurationDoneSent) {
        console.log("No configurationDone found; calling configurationDone...");
        try {
          const confResp = await dapClient.configurationDone();
          console.log("configurationDone response:", confResp);
          configurationDoneSent = true;
          globalThis.configurationDoneSent = true;
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes('"configurationDone" is only allowed')
          ) {
            console.log(
              "ConfigurationDone was rejected because it is only allowed during launch/attach; proceeding.",
            );
            configurationDoneSent = true;
            globalThis.configurationDoneSent = true;
          } else {
            throw err;
          }
        }
      }
      const { threadId } = req.body;
      const effectiveThreadId = threadId || 1;
      const contResp = await dapClient.continue(effectiveThreadId);
      res.status(200).json({ result: contResp.body });
    } else if (action === "status") {
      // -----------------------------------------------------------------
      // Return the status of the debug session
      // -----------------------------------------------------------------
      if (!dapClient) {
        res.status(200).json({ status: "inactive" });
        return;
      }
      if (!dapClient.isPaused) {
        res.status(200).json({ status: "running" });
        return;
      }
      const location = dapClient.currentPausedLocation || {};
      res.status(200).json({
        status: "paused",
        file: location.file,
        line: location.line,
      });
    } else {
      res.status(400).json({ error: "Unknown action" });
    }
  } catch (error: unknown) {
    console.error("Error in debug API:", error);
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred" });
    }
  }
}
