#!/usr/bin/env node
/**
 * A minimal DAP client that:
 * - launches the js-debug DAP server
 * - connects to it over TCP
 * - sends an initialize request, then a launch request
 * - waits for the initialized event after launch
 * - sends setBreakpoints and configurationDone requests
 * - waits for a breakpoint hit (stopped event)
 * - requests a stack trace to obtain a frame id
 * - sends an evaluate request to inspect a variable at the breakpoint
 * - sends continue requests until the debugger is no longer stopping
 * - waits for the target process to terminate, then exits
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Global variables to help manage DAP messages
let nextSeq = 1;
const responses = {};
const events = {};

// Path to the js-debug DAP server
const DAP_SERVER_PATH = path.resolve(
  __dirname,
  "../../vscode-js-debug/dist/src/dapDebugServer.js",
);
const TARGET_SCRIPT = path.resolve(__dirname, "../test_data/js/a.js");
const DAP_PORT = 8123;

function nextSequence() {
  return nextSeq++;
}

function sendDapMessage(socket, message) {
  const data = JSON.stringify(message);
  const header = `Content-Length: ${data.length}\r\n\r\n`;
  socket.write(header + data);
  console.log(
    `--> Sent (seq ${message.seq}, cmd: ${message.command}): ${data}\n`,
  );
}

function readDapMessage(data, callback) {
  // This is a simplified implementation
  // In a real scenario, you'd want to handle partial messages properly
  const match = data.toString().match(/Content-Length: (\d+)\r\n\r\n(.*)/s);
  if (match) {
    const length = parseInt(match[1]);
    const content = match[2];
    if (content.length >= length) {
      const message = JSON.parse(content.substring(0, length));
      console.log(`<-- Received: ${JSON.stringify(message)}\n`);
      callback(message);

      // If there's more data, process it
      if (content.length > length) {
        readDapMessage(Buffer.from(content.substring(length)), callback);
      }
    }
  }
}

function waitForEvent(eventName, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    function check() {
      if (events[eventName] && events[eventName].length > 0) {
        return resolve(events[eventName].shift());
      }

      if (Date.now() - startTime > timeout) {
        return reject(new Error(`Timeout waiting for event ${eventName}`));
      }

      setTimeout(check, 100);
    }

    check();
  });
}

function waitForResponse(seq, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    function check() {
      if (responses[seq]) {
        const response = responses[seq];
        delete responses[seq];
        return resolve(response);
      }

      if (Date.now() - startTime > timeout) {
        return reject(new Error(`Timeout waiting for response to seq ${seq}`));
      }

      setTimeout(check, 100);
    }

    check();
  });
}

async function main() {
  // Buffer to capture the output of the target script
  const outputBuffer = [];

  // Start DAP server
  console.log(`Starting DAP server from: ${DAP_SERVER_PATH}`);
  const dapProcess = spawn("node", [DAP_SERVER_PATH, DAP_PORT]);

  dapProcess.stdout.on("data", (data) => {
    console.log(`[DAP server] ${data.toString().trim()}`);
  });

  dapProcess.stderr.on("data", (data) => {
    console.error(`[DAP server error] ${data.toString().trim()}`);
  });

  // Wait a moment for the server to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect to DAP server
  const socket = new net.Socket();
  await new Promise((resolve, reject) => {
    socket.connect(DAP_PORT, "localhost", () => {
      console.log("Connected to DAP server");
      resolve();
    });
    socket.on("error", reject);
  });

  // Set up message handler
  let buffer = Buffer.alloc(0);
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    try {
      readDapMessage(buffer, (message) => {
        buffer = Buffer.alloc(0); // Clear buffer after successful processing

        const msgType = message.type;
        if (msgType === "response") {
          responses[message.request_seq] = message;
        } else if (msgType === "event") {
          if (!events[message.event]) {
            events[message.event] = [];
          }
          events[message.event].push(message);
        } else {
          console.log("Unknown message type", message);
        }
      });
    } catch (e) {
      // Probably an incomplete message, will continue on next data chunk
    }
  });

  try {
    // Step 3: Send initialize request - following the same naming as in Python sample
    const initSeq = nextSequence();
    const initReq = {
      seq: initSeq,
      type: "request",
      command: "initialize",
      arguments: {
        adapterID: "javascript",
        clientID: "dap_test_client",
        clientName: "DAP Test",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: true,
        supportsEvaluateForHovers: true,
      },
    };
    sendDapMessage(socket, initReq);
    const initResp = await waitForResponse(initSeq);
    console.log("Received initialize response:", initResp);

    // Step 4: Send launch request (equivalent to the attach request in Python)
    const launchSeq = nextSequence();
    const launchReq = {
      seq: launchSeq,
      type: "request",
      command: "launch",
      arguments: {
        program: TARGET_SCRIPT,
        type: "node",
        request: "launch",
        stopOnEntry: false,
        console: "integratedTerminal",
        cwd: path.dirname(TARGET_SCRIPT),
      },
    };
    sendDapMessage(socket, launchReq);
    await waitForResponse(launchSeq);
    // Sleep a short time after launch, similar to Python code
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Wait for the "initialized" event sent by the adapter - same as Python
    await waitForEvent("initialized");
    console.log("Initialization complete");

    // Step 5: Send setBreakpoints request
    const bpSeq = nextSequence();
    const setBpReq = {
      seq: bpSeq,
      type: "request",
      command: "setBreakpoints",
      arguments: {
        source: {
          path: TARGET_SCRIPT,
          name: path.basename(TARGET_SCRIPT),
        },
        breakpoints: [
          { line: 14 }, // Line where nextVal is calculated in computeFibonacci
        ],
        sourceModified: false,
      },
    };
    sendDapMessage(socket, setBpReq);
    const bpResp = await waitForResponse(bpSeq);
    console.log("Breakpoints response:", bpResp);
    if (!bpResp.success) {
      console.log("Error setting breakpoints:", bpResp.message);
    }

    // Step 6: Send configurationDone request
    const confSeq = nextSequence();
    const confReq = {
      seq: confSeq,
      type: "request",
      command: "configurationDone",
      arguments: {},
    };
    sendDapMessage(socket, confReq);
    const confResp = await waitForResponse(confSeq);
    console.log("ConfigurationDone response:", confResp);

    // Step 7: Wait for the "stopped" event
    console.log(
      "Waiting for the target to hit the breakpoint (stopped event)...",
    );
    const stoppedEvent = await waitForEvent("stopped", 15000);
    console.log("Received stopped event:", stoppedEvent);
    const threadId = stoppedEvent.body?.threadId || 1;

    // Request a stack trace to get the correct frame id
    const stSeq = nextSequence();
    const stReq = {
      seq: stSeq,
      type: "request",
      command: "stackTrace",
      arguments: {
        threadId: threadId,
        startFrame: 0,
        levels: 1,
      },
    };
    sendDapMessage(socket, stReq);
    const stResp = await waitForResponse(stSeq);
    console.log("StackTrace response:", stResp);
    const frames = stResp.body?.stackFrames || [];
    const frameId = frames[0]?.id;
    console.log("Using frameId:", frameId);

    // Step 8: While stopped, send an evaluate request for "nextVal"
    const evalSeq = nextSequence();
    const evalArgs = {
      expression: "nextVal",
      context: "hover",
    };
    if (frameId) {
      evalArgs.frameId = frameId;
    }
    const evalReq = {
      seq: evalSeq,
      type: "request",
      command: "evaluate",
      arguments: evalArgs,
    };
    sendDapMessage(socket, evalReq);
    const evalResp = await waitForResponse(evalSeq);
    console.log("Evaluate response:", evalResp);
    const resultValue = evalResp.body?.result;
    console.log("Value of nextVal at breakpoint:", resultValue);

    // Step 9: Send a continue request
    const contSeq = nextSequence();
    const contReq = {
      seq: contSeq,
      type: "request",
      command: "continue",
      arguments: { threadId: threadId },
    };
    sendDapMessage(socket, contReq);
    const contResp = await waitForResponse(contSeq);
    console.log("Continue response:", contResp);

    // Loop to send continue requests until no stopped event remains
    while (true) {
      try {
        const extraStoppedEvent = await waitForEvent("stopped", 1000);
        console.log("Extra stopped event received; sending another continue.");
        const extraContSeq = nextSequence();
        const extraContReq = {
          seq: extraContSeq,
          type: "request",
          command: "continue",
          arguments: { threadId: threadId },
        };
        sendDapMessage(socket, extraContReq);
        const extraContResp = await waitForResponse(extraContSeq);
        console.log("Extra continue response:", extraContResp);
      } catch (e) {
        // No more stopped events - timeout occurred
        break;
      }
    }

    // Wait for the target process to terminate
    await waitForEvent("terminated", 10000);
    console.log("Target process terminated.");

    // Clean up
    socket.end();
    dapProcess.kill();

    console.log("\n----- Test completed successfully -----");
  } catch (error) {
    console.error("Error during DAP test:", error);
    socket.end();
    dapProcess.kill();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
