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

      // Capture stdout for streaming to the SSE
      pythonProcess.stdout?.on("data", (data: Buffer) => {
        sendOutput(data.toString());
      });

      // Wait for debugpy to start up
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Create new DAPClient
      dapClient = new DAPClient();
      await dapClient.connect("127.0.0.1", debugpyPort);
      console.log("Connected to DAP server on port", debugpyPort);

      globalThis.dapClient = dapClient;
      globalThis.pythonProcess = pythonProcess;

      const initResp = await dapClient.initialize();
      console.log("Initialize response:", initResp);

      await dapClient.attach("127.0.0.1", debugpyPort);
      console.log("Attach sent and initialized event received");

      res.status(200).json({
        success: true,
        message:
          "Debug session launched. The script is running. Any breakpoints that were set before launch are active.",
      });

      // ------------------------------------------------------------------------
      // ACTION: SET BREAKPOINTS
      // ------------------------------------------------------------------------
    } else if (action === "setBreakpoints") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      if (configurationDoneSent) {
        // Program is already running / started, so this breakpoint might not do anything
        // (or might only apply if you pause, set breakpoints, then continue).
        // We'll still set them in DAP so they're recognized if the program is paused.
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

      // Note: We do NOT call configurationDone here, because that would prematurely run the script if it isn't launched.
      // So if you want the script to run, do /api/debug?action=launch afterward.

      // TODO update this message
      res.status(200).json({
        breakpoints: bpResp.body?.breakpoints || [],
        message: configurationDoneSent
          ? "Set breakpoints after program started; might only matter if you pause now."
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
      const effectiveThreadId =
        threadId || (dapClient.currentPausedLocation ? 1 : 1);

      // get top frame
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
        });
      }
      // ------------------------------------------------------------------------
      // ACTION: CONFIGURATION DONE -- starts program execution
      // ------------------------------------------------------------------------
    } else if (action === "configurationDone") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      if (!configurationDoneSent) {
        // Send configurationDone so the target script continues running.
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
