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
import net from "net";
import { Fullscreen } from "lucide-react";

const targetScript = path.join(
  process.cwd(),
  "..",
  "dap",
  "test_scripts",
  "test_data",
  "c.py",
);

// Simple helper that logs process output for the specified session token.
function sendOutput(data: string, token: string) {
  console.log(`[Python stdout][Session:${token}]:`, data);
  // Add to the global buffer for this session
  if (!globalThis.debugOutputBuffers) {
    globalThis.debugOutputBuffers = {};
  }
  if (!globalThis.debugOutputBuffers[token]) {
    globalThis.debugOutputBuffers[token] = [];
  }
  globalThis.debugOutputBuffers[token].push(data.trim());
}

function findAvailablePort(startPort: number = 5678): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Port is in use, try the next one
        findAvailablePort(startPort + 1)
          .then(resolve)
          .catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Reads the token either from ?token=... or from the JSON body { token: "..." }
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

      // Start debugpy on an available port
      const debugpyPort = await findAvailablePort();
      const pythonProcess = spawn(
        "python",
        [
          "-u",
          "-m",
          "debugpy",
          "--listen",
          `127.0.0.1:${debugpyPort}`,
          "--wait-for-client",
          targetScript,
        ],
        {
          stdio: ["inherit", "pipe", "pipe"],
        },
      );
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
        const output = data.toString();
        const lines = output.split("\n");
        lines.forEach((line) => {
          if (line.trim()) {
            sendOutput(line, session.token);
          }
        });
      });

      pythonProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        const lines = output.split("\n");
        lines.forEach((line) => {
          if (line.trim()) {
            sendOutput(`[ERROR] ${line}`, session.token);
          }
        });
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
        const { breakpoints, filePath } = req.body;
        if (!Array.isArray(breakpoints)) {
          res.status(400).json({ error: "Missing breakpoints array" });
          return;
        }
        if (!filePath) {
          res.status(400).json({ error: "Missing filePath" });
          return;
        }

        const fullScriptPath = path.join(
          process.cwd(),
          "..",
          "dap",
          "test_scripts",
          "test_data",
          filePath,
        );
        const bpResp = await dapClient.setBreakpoints(
          fullScriptPath,
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
        // Only GET is allowed for SSE status updates.
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          res.status(405).json({
            error: "Method not allowed. Use GET for SSE status updates.",
          });
          return;
        }

        // Set up SSE headers
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        // Helper function to send the current status based on the session's DAPClient.
        const sendStatus = () => {
          let payload;
          if (!dapClient) {
            payload = { status: "inactive" };
          } else if (dapClient.terminated) {
            payload = { status: "terminated" };
          } else if (!dapClient.isPaused) {
            payload = { status: "running" };
          } else {
            const location = dapClient.currentPausedLocation || {};
            payload = {
              status: "paused",
              file: location.file || null,
              line: location.line || null,
              threadId: dapClient.currentThreadId || 1,
            };
          }
          console.log(
            `[SSE ${new Date().toISOString()}] Sending status:`,
            payload,
          );
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        // Register event listeners on the session's DAPClient.
        const eventListener = () => {
          sendStatus();
        };
        if (dapClient) {
          dapClient.on("stopped", eventListener);
          dapClient.on("continued", eventListener);
          dapClient.on("terminated", eventListener);
          dapClient.on("pausedLocationUpdated", eventListener);
        }

        // Send an initial status.
        console.log(
          `[SSE ${new Date().toISOString()}] Sending initial status.`,
        );
        sendStatus();

        // Send heartbeat periodically to keep the connection alive.
        const heartbeat = setInterval(() => {
          console.log(`[SSE ${new Date().toISOString()}] Sending heartbeat.`);
          res.write(":\n\n");
        }, 15000);

        // On client disconnection, remove listeners and clear intervals.
        req.on("close", () => {
          console.log(
            `[SSE ${new Date().toISOString()}] Client disconnected. Cleaning up.`,
          );
          clearInterval(heartbeat);
          if (dapClient) {
            dapClient.off("stopped", eventListener);
            dapClient.off("continued", eventListener);
            dapClient.off("terminated", eventListener);
            dapClient.off("pausedLocationUpdated", eventListener);
          }
          res.end();
        });
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
