"use strict";

import type { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import path from "path";
import { DAPClient } from "../../lib/dapClient";
import {
  createDebugSession,
  getDebugSession,
  cleanUpSession,
} from "../../lib/sessionManager";

const targetScript = path.join(
  process.cwd(),
  "..",
  "dap",
  "test_scripts",
  "test_data",
  "a.py",
);

// Simple helper that logs process output for the specified session token.
function sendOutput(data: string, token: string) {
  console.log(`[Python stdout][Session:${token}]:`, data);
}

/**
 * Reads the token either from ?token=... or from the JSON body { token: "..."}
 */
function getTokenFromRequest(req: NextApiRequest): string | undefined {
  const { token } = req.query;
  if (typeof token === "string") {
    return token;
  }
  if (req.body && typeof req.body.token === "string") {
    return req.body.token;
  }
  return undefined;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const { action } = req.query;

  // Only "status" can be GET; everything else must be POST.
  if (req.method !== "POST" && action !== "status") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    if (action === "launch") {
      // If the client provided a token in the request, try cleaning up any old session with that token.
      const existingToken = getTokenFromRequest(req);
      if (existingToken) {
        cleanUpSession(existingToken);
      }

      // Start debugpy on port 5678
      const debugpyPort = 5678;
      const pythonProcess = spawn("python", [
        "-u",
        "-m",
        "debugpy",
        "--listen",
        `127.0.0.1:${debugpyPort}`,
        "--wait-for-client",
        targetScript,
      ]);
      console.log("Launched Python process with PID:", pythonProcess.pid);

      // Wait longer for debugpy to bind to the port (2 seconds).
      // If it's still finishing, increase this to 3 or 5 seconds, or do a retry approach.
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Create & connect a brand-new DAPClient
      const dapClient = new DAPClient();
      await dapClient.connect("127.0.0.1", debugpyPort);
      console.log("Connected to DAP server on port", debugpyPort);

      // Create a new session. This gives us a token.
      const session = createDebugSession(dapClient, pythonProcess);

      // Attach stdout logging so we can see Python logs for this session
      pythonProcess.stdout?.on("data", (data: Buffer) => {
        sendOutput(data.toString(), session.token);
      });

      // Initialize & attach
      await dapClient.initialize();
      await dapClient.attach("127.0.0.1", debugpyPort);

      // Return JSON with the new token
      res.status(200).json({
        success: true,
        token: session.token,
        message: "Debug session launched successfully.",
      });
    } else {
      // For all other actions, we require a valid session token.
      const token = getTokenFromRequest(req);
      if (!token) {
        res.status(400).json({ error: "Missing token" });
        return;
      }
      const session = getDebugSession(token);
      if (!session) {
        res.status(400).json({ error: "No session found" });
        return;
      }
      const dapClient = session.dapClient;

      if (action === "setBreakpoints") {
        const { breakpoints } = req.body;
        if (!Array.isArray(breakpoints)) {
          res.status(400).json({ error: "Missing breakpoints array" });
          return;
        }
        const bpResp = await dapClient.setBreakpoints(
          targetScript,
          breakpoints,
        );
        res.status(200).json({ breakpoints: bpResp.body?.breakpoints || [] });
      } else if (action === "evaluate") {
        const { expression, threadId } = req.body;
        if (!expression) {
          res.status(400).json({ error: "Missing expression in request" });
          return;
        }
        const effThreadId = threadId || 1;
        const stackResp = await dapClient.stackTrace(effThreadId);
        let frameId: number | undefined;
        if (stackResp.body?.stackFrames?.length) {
          frameId = stackResp.body.stackFrames[0].id;
        }
        const evalResp = await dapClient.evaluate(expression, frameId);
        res.status(200).json({ result: evalResp.body?.result });
      } else if (action === "continue") {
        const { threadId } = req.body;
        const effThreadId = threadId || 1;
        const contResp = await dapClient.continue(effThreadId);
        res.status(200).json({ result: contResp.body });
      } else if (action === "stepOver") {
        const { threadId } = req.body;
        const effThreadId = threadId || 1;
        const stepResp = await dapClient.next(effThreadId);
        res.status(200).json({ result: stepResp.body });
      } else if (action === "stepIn") {
        const { threadId } = req.body;
        const effThreadId = threadId || 1;
        const stepInResp = await dapClient.stepIn(effThreadId);
        res.status(200).json({ result: stepInResp.body });
      } else if (action === "stepOut") {
        const { threadId } = req.body;
        const effThreadId = threadId || 1;
        const stepOutResp = await dapClient.stepOut(effThreadId);
        res.status(200).json({ result: stepOutResp.body });
      } else if (action === "terminate") {
        const termResp = await dapClient.terminate();
        cleanUpSession(token);
        res.status(200).json({ result: termResp.body });
      } else if (action === "configurationDone") {
        if (!session.configurationDoneSent) {
          const confResp = await dapClient.configurationDone();
          session.configurationDoneSent = true;
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
      } else if (action === "stackTrace") {
        const { threadId } = req.body;
        const effThreadId = threadId || 1;
        const stResp = await dapClient.stackTrace(effThreadId, 0, 20);
        res.status(200).json({ stackFrames: stResp.body?.stackFrames || [] });
      } else if (action === "status") {
        // SSE for status updates. Not fully implemented, so we can short-circuit here:
        return res.status(501).json({ error: "Not implemented here" });
      } else {
        res.status(400).json({ error: `Unknown action: ${action}` });
      }
    }
  } catch (error) {
    console.error("Error in debug API:", error);
    if (error instanceof Error) {
      res.status(500).json({ error: error.message });
    } else {
      res.status(500).json({ error: "An unknown error occurred" });
    }
  }
}
