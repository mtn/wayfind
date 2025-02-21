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
        console.log("Closing DAP client");
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
      const nextResp = await dapClient.next(effectiveThreadId);
      res.status(200).json({ result: nextResp.body });

      // ------------------------------------------------------------------------
      // ACTION: STEP IN
      // ------------------------------------------------------------------------
    } else if (action === "stepIn") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      const { threadId } = req.body;
      const effectiveThreadId = threadId || 1;
      const stepInResp = await dapClient.stepIn(effectiveThreadId);
      res.status(200).json({ result: stepInResp.body });

      // ------------------------------------------------------------------------
      // ACTION: STEP OUT
      // ------------------------------------------------------------------------
    } else if (action === "stepOut") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      const { threadId } = req.body;
      const effectiveThreadId = threadId || 1;
      const stepOutResp = await dapClient.stepOut(effectiveThreadId);
      res.status(200).json({ result: stepOutResp.body });

      // ------------------------------------------------------------------------
      // ACTION: TERMINATE
      // ------------------------------------------------------------------------
    } else if (action === "terminate") {
      if (!dapClient) {
        throw new Error("No DAP session. Please launch first.");
      }
      const termResp = await dapClient.terminate();
      res.status(200).json({ result: termResp.body });

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
      // ACTION: STACK TRACE (added to support CallStack component)
      // ------------------------------------------------------------------------
    } else if (action === "stackTrace") {
      if (!dapClient) {
        res.status(400).json({ error: "No DAP session. Please launch first." });
        return;
      }
      const { threadId } = req.body;
      const effectiveThreadId = threadId || 1;
      const stResp = await dapClient.stackTrace(effectiveThreadId, 0, 20);
      res.status(200).json({ stackFrames: stResp.body?.stackFrames || [] });

      // ------------------------------------------------------------------------
      // ACTION: STATUS
      // ------------------------------------------------------------------------
    } else if (action === "status") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        res.status(405).json({
          error: "Method not allowed. Use GET for SSE status updates.",
        });
        return;
      }

      console.log(
        `[SSE ${new Date().toISOString()}] Setting up SSE connection for status updates.`,
      );
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      // Function to compute and send the current status.
      function sendStatus() {
        const client = globalThis.dapClient;
        let payload;
        if (!client) {
          payload = { status: "inactive" };
        } else if (client.terminated) {
          payload = { status: "terminated" };
        } else if (!client.isPaused) {
          payload = { status: "running" };
        } else {
          const location = client.currentPausedLocation || {};
          payload = {
            status: "paused",
            file: location.file || null,
            line: location.line || null,
            threadId: client.currentThreadId || 1,
          };
        }
        console.log(
          `[SSE ${new Date().toISOString()}] Sending status:`,
          payload,
        );
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }

      // Dynamic registration of event listeners on the latest DAPClient.
      let currentClient = globalThis.dapClient;
      const eventListener = (msg: any) => {
        sendStatus();
      };
      const registrationInterval = setInterval(() => {
        if (globalThis.dapClient && globalThis.dapClient !== currentClient) {
          if (currentClient) {
            currentClient.off("stopped", eventListener);
            currentClient.off("continued", eventListener);
            currentClient.off("terminated", eventListener);
          }
          currentClient = globalThis.dapClient;
          console.log(
            `[SSE ${new Date().toISOString()}] Registering listeners on new DAPClient instance.`,
          );
          currentClient.on("stopped", eventListener);
          currentClient.on("continued", eventListener);
          currentClient.on("terminated", eventListener);
          sendStatus();
        }
      }, 500);

      // Send the initial status.
      console.log(`[SSE ${new Date().toISOString()}] Sending initial status.`);
      sendStatus();

      // Heartbeat: send a heartbeat message every 15 seconds.
      const heartbeat = setInterval(() => {
        console.log(`[SSE ${new Date().toISOString()}] Sending heartbeat.`);
        res.write(":\n\n");
      }, 15000);

      // Cleanup on client disconnect.
      req.on("close", () => {
        console.log(
          `[SSE ${new Date().toISOString()}] Client disconnected. Cleaning up listeners and heartbeat.`,
        );
        clearInterval(heartbeat);
        clearInterval(registrationInterval);
        if (currentClient) {
          currentClient.off("stopped", eventListener);
          currentClient.off("continued", eventListener);
          currentClient.off("terminated", eventListener);
        }
        res.end();
      });

      // ------------------------------------------------------------------------
      // ACTION: UNKNOWN
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
