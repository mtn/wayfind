import { spawn } from "child_process";
import path from "path";
import WebSocket, { WebSocketServer } from "ws";
import { DAPClient } from "./dapClient";

// Global state – one active debug session per server instance.
let dapClient: DAPClient | null = null;
let pythonProcess: ReturnType<typeof spawn> | null = null;

// Adjust this to your actual target script.
const targetScript = path.join(
  process.cwd(),
  "..",
  "dap",
  "test_scripts",
  "test_data",
  "a.py",
);

// Create a WebSocket server on port 8080 (or another port)
const wss = new WebSocketServer({ port: 8080 });
console.log("WebSocket server listening on port 8080");

// When a new client connects, set up message handlers.
wss.on("connection", (ws: WebSocket) => {
  console.log("New WebSocket client connected");

  // When a client sends a message (a JSON command), parse it and call the proper handler.
  ws.on("message", async (message: string) => {
    try {
      const data = JSON.parse(message);
      const { action, payload, requestId } = data;
      console.log(`Received action "${action}" with payload:`, payload);

      // Dispatch the actions to appropriate handlers.
      switch (action) {
        case "launch":
          await handleLaunch(ws, requestId, payload);
          break;
        case "setBreakpoints":
          await handleSetBreakpoints(ws, requestId, payload);
          break;
        case "continue":
          await handleContinue(ws, requestId, payload);
          break;
        case "stackTrace":
          await handleStackTrace(ws, requestId, payload);
          break;
        case "evaluate":
          await handleEvaluate(ws, requestId, payload);
          break;
        default:
          ws.send(JSON.stringify({ requestId, error: "Unknown action" }));
      }
    } catch (err) {
      console.error("Error processing WS message:", err);
      ws.send(
        JSON.stringify({
          error: err instanceof Error ? err.message : err,
        }),
      );
    }
  });
});

// Helper: broadcast an event to all connected clients.
function broadcastEvent(event: any) {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client: any) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Patch dapClient so that every “event” received is immediately pushed via WS.
function setupDAPEventListeners(client: DAPClient) {
  client.on("event", (msg: any) => {
    // For example, a "stopped" event will be broadcast.
    broadcastEvent({ type: "event", payload: msg });
  });
}

// Handler for the “launch” command.
async function handleLaunch(ws: WebSocket, requestId: number, payload: any) {
  try {
    // If there's an existing session, clean it up.
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

    // Wait a bit for debugpy to start.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Initialize DAP client connection.
    dapClient = new DAPClient();
    await dapClient.connect("127.0.0.1", debugpyPort);
    console.log("Connected to DAP server on port", debugpyPort);

    const initResp = await dapClient.initialize();
    console.log("Initialize response:", initResp);

    // Attach to debugpy – do not call configurationDone yet.
    await dapClient.attach("127.0.0.1", debugpyPort);
    console.log("Attach sent and initialized event received");

    // Set up event forwarding.
    setupDAPEventListeners(dapClient);

    ws.send(
      JSON.stringify({
        requestId,
        result: {
          success: true,
          message: "Debug session launched. Set breakpoints and then run.",
        },
      }),
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        requestId,
        error: err instanceof Error ? err.message : err,
      }),
    );
  }
}

// Handler for the “setBreakpoints” command.
async function handleSetBreakpoints(
  ws: WebSocket,
  requestId: number,
  payload: any,
) {
  try {
    if (!dapClient) {
      throw new Error("No active DAP session; launch first.");
    }
    // Expect payload to include breakpoints array and filePath string.
    const { breakpoints, filePath } = payload;
    console.log("Setting breakpoints for file:", filePath);

    const bpResp = await dapClient.setBreakpoints(filePath, breakpoints);
    console.log("Breakpoint response:", bpResp);

    // Now call configurationDone so the debug session can run.
    const confResp = await dapClient.configurationDone();
    console.log("configurationDone response:", confResp);

    ws.send(
      JSON.stringify({
        requestId,
        result: { breakpoints: bpResp.body?.breakpoints || [], confResp },
      }),
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        requestId,
        error: err instanceof Error ? err.message : err,
      }),
    );
  }
}

// Handler for the “continue” command.
async function handleContinue(ws: WebSocket, requestId: number, payload: any) {
  try {
    if (!dapClient) {
      throw new Error("No active DAP session; launch first.");
    }
    const { threadId } = payload;
    const contResp = await dapClient.continue(threadId || 1);
    ws.send(
      JSON.stringify({
        requestId,
        result: { continueResult: contResp.body },
      }),
    );
    // The DAP "stopped" event (carrying breakpoint info) will be broadcast to all clients.
  } catch (err) {
    ws.send(
      JSON.stringify({
        requestId,
        error: err instanceof Error ? err.message : err,
      }),
    );
  }
}

// Handler for the “stackTrace” command.
async function handleStackTrace(
  ws: WebSocket,
  requestId: number,
  payload: any,
) {
  try {
    if (!dapClient) {
      throw new Error("No active DAP session; launch first.");
    }
    const { threadId } = payload;
    const stResp = await dapClient.stackTrace(threadId || 1);
    ws.send(JSON.stringify({ requestId, result: stResp.body }));
  } catch (err) {
    ws.send(
      JSON.stringify({
        requestId,
        error: err instanceof Error ? err.message : err,
      }),
    );
  }
}

// Handler for the “evaluate” command.
async function handleEvaluate(ws: WebSocket, requestId: number, payload: any) {
  try {
    if (!dapClient) {
      throw new Error("No active DAP session; launch first.");
    }
    const { expression, threadId } = payload;
    // To get frame context, we retrieve a stackTrace.
    const stResp = await dapClient.stackTrace(threadId || 1);
    let frameId: number | undefined;
    if (stResp.body?.stackFrames && stResp.body.stackFrames.length > 0) {
      frameId = stResp.body.stackFrames[0].id;
    }
    const evalResp = await dapClient.evaluate(expression, frameId);
    ws.send(
      JSON.stringify({
        requestId,
        result: evalResp.body?.result,
      }),
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        requestId,
        error: err instanceof Error ? err.message : err,
      }),
    );
  }
}

export {};
