"use strict";

import type { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import path from "path";
import { DAPClient } from "../../lib/dapClient";

// --------------------------------------------------------------------------
// GLOBALS
// --------------------------------------------------------------------------
declare global {
  var dapClient: DAPClient | null | undefined;
  var pythonProcess: ReturnType<typeof spawn> | null | undefined;
  var configurationDoneSent: boolean | undefined;
  var debugOutputBuffer: string[] | undefined;
}

if (globalThis.dapClient === undefined) {
  globalThis.dapClient = null;
}
if (globalThis.pythonProcess === undefined) {
  globalThis.pythonProcess = null;
}
if (globalThis.configurationDoneSent === undefined) {
  globalThis.configurationDoneSent = false;
}
if (globalThis.debugOutputBuffer === undefined) {
  globalThis.debugOutputBuffer = [];
}

let dapClient: DAPClient | null = globalThis.dapClient;
let pythonProcess: ReturnType<typeof spawn> | null = globalThis.pythonProcess;
let configurationDoneSent: boolean = globalThis.configurationDoneSent;

// Adjust target script below as needed.
const targetScript = path.join(
  process.cwd(),
  "..",
  "dap",
  "test_scripts",
  "test_data",
  "a.py",
);

// --------------------------------------------------------------------------
// HELPER: Send output to SSE consumers.
// --------------------------------------------------------------------------
function sendOutput(data: string) {
  globalThis.debugOutputBuffer!.push(data);
  console.log("Buffered output:", data);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  // Only allow POST for most actions. "status" may be GET.
  const { action } = req.query;
  if (req.method !== "POST" && action !== "status") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // ------------------------------------------------------------------------
    // ACTION: LAUNCH
    // ------------------------------------------------------------------------
    if (action === "launch") {
      // If we already have a running pythonProcess, kill it
      if (pythonProcess) {
        pythonProcess.kill();
        pythonProcess = null;
      }
      if (dapClient) {
        dapClient.close();
        dapClient = null;
      }
      configurationDoneSent = false;
      globalThis.configurationDoneSent = false;

      const debugpyPort = 5678;

      // Start the python script with debugpy
      pythonProcess = spawn("python", [
        "-u",
        "-m",
        "debugpy",
        "--listen",
        `127.0.0.1:${debugpyPort}`,
        "--wait-for-client",
        targetScript,
      ]);
      console.log("Launched Python process with PID:", pythonProcess.pid);

      // Capture stdout for streaming to SSE, if needed.
      pythonProcess.stdout?.on("data", (data: Buffer) => {
        sendOutput(data.toString());
      });

      // Wait a bit for debugpy to start.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Create new DAPClient and connect.
      dapClient = new DAPClient();
      await dapClient.connect("127.0.0.1", debugpyPort);
      console.log("Connected to DAP server on port", debugpyPort);
      globalThis.dapClient = dapClient;
      globalThis.pythonProcess = pythonProcess;

      // Send initialize request
      const initResp = await dapClient.initialize();
      console.log("Initialize response:", initResp);

      // Send attach request
      const attachReq = {
        action: "attach",
        host: "127.0.0.1",
        port: debugpyPort,
      };
      await dapClient.attach("127.0.0.1", debugpyPort);
      console.log("Attach sent and initialized event received");

      res.status(200).json({
        success: true,
        message:
          "Debug session launched. The script is running. Breakpoints set before launch are active.",
      });

      // ------------------------------------------------------------------------
      // ACTION: SET BREAKPOINTS
      // ------------------------------------------------------------------------
    } else if (action === "setBreakpoints") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      if (configurationDoneSent) {
        console.log(
          "Warning: Program already launched; new breakpoints may not be hit unless paused.",
        );
      }
      const { breakpoints } = req.body;
      if (!Array.isArray(breakpoints)) {
        res
          .status(400)
          .json({ error: "Missing or malformed breakpoints array" });
        return;
      }
      console.log("Setting breakpoints for script:", targetScript);
      const bpResp = await dapClient.setBreakpoints(targetScript, breakpoints);
      console.log("Breakpoint response:", bpResp);

      res.status(200).json({
        breakpoints: bpResp.body?.breakpoints || [],
        message: configurationDoneSent
          ? "Set breakpoints after program started; might only matter if you pause."
          : "Breakpoints set – they will take effect once you launch the program.",
      });

      // ------------------------------------------------------------------------
      // ACTION: EVALUATE
      // ------------------------------------------------------------------------
    } else if (action === "evaluate") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      const { expression, threadId } = req.body;
      if (!expression) {
        res.status(400).json({ error: "Missing expression in request body" });
        return;
      }
      // Get a frame id from stackTrace if necessary.
      const effectiveThreadId = threadId || 1;
      const stackResp = await dapClient.stackTrace(effectiveThreadId);
      let frameId: number | undefined;
      if (stackResp.body?.stackFrames?.length) {
        frameId = stackResp.body.stackFrames[0].id;
      }
      const evalResp = await dapClient.evaluate(expression, frameId);
      res.status(200).json({ result: evalResp.body?.result });

      // ------------------------------------------------------------------------
      // ACTION: CONTINUE
      // ------------------------------------------------------------------------
    } else if (action === "continue") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      const { threadId } = req.body;
      const effectiveThreadId = threadId || 1;
      const contResp = await dapClient.continue(effectiveThreadId);
      res.status(200).json({ result: contResp.body });

      // ------------------------------------------------------------------------
      // ACTION: STEP OVER
      // ------------------------------------------------------------------------
    } else if (action === "stepOver") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      const { threadId } = req.body;
      const effectiveThreadId = threadId || 1;
      // Call the next() request, which implements step over.
      const nextResp = await dapClient.next(effectiveThreadId);
      res.status(200).json({ result: nextResp.body });

      // ------------------------------------------------------------------------
      // ACTION: CONFIGURATION DONE
      // ------------------------------------------------------------------------
    } else if (action === "configurationDone") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      if (!configurationDoneSent) {
        const confResp = await dapClient.configurationDone();
        configurationDoneSent = true;
        globalThis.configurationDoneSent = true;
        console.log("configurationDone response:", confResp);
        res.status(200).json({
          success: true,
          message: "configurationDone sent; target program is now running.",
          response: confResp,
        });
      } else {
        res.status(200).json({
          success: true,
          message: "configurationDone has already been sent.",
        });
      }

      // ------------------------------------------------------------------------
      // ACTION: STATUS
      // ------------------------------------------------------------------------
    } else if (action === "status") {
      if (!dapClient) {
        res.status(200).json({ status: "inactive" });
      } else if (dapClient.terminated) {
        res.status(200).json({ status: "terminated" });
      } else if (!dapClient.isPaused) {
        res.status(200).json({ status: "running" });
      } else {
        const location = dapClient.currentPausedLocation || {};
        res.status(200).json({
          status: "paused",
          file: location.file,
          line: location.line,
          threadId: dapClient.currentThreadId || 1,
        });
      }

      // ------------------------------------------------------------------------
      // UNKNOWN ACTION
      // ------------------------------------------------------------------------
    } else {
      res.status(400).json({ error: `Unknown action: ${action}` });
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
