"use strict";

import net from "net";
import { EventEmitter } from "events";
import path from "path";

let instanceCounter = 0;

export interface DAPMessage {
  seq: number;
  type: "request" | "response" | "event";
  command?: string;
  request_seq?: number;
  success?: boolean;
  body?: any;
  event?: string;
  arguments?: any;
}

const SEQ_UNASSIGNED = -1;

export class DAPClient extends EventEmitter {
  public id: number;
  private socket: net.Socket;
  private buffer: string;
  private nextSeq: number;
  // Responses keyed by request_seq for "response" messages.
  private pendingResponses: Map<number, DAPMessage>;
  private eventQueue: Map<string, DAPMessage[]>;
  // New fields to track paused status and location
  public currentPausedLocation: { file?: string; line?: number } | null = null;
  public isPaused: boolean = false;
  public terminated: boolean = false;
  public currentThreadId: number | null = null;

  constructor() {
    super();
    this.id = ++instanceCounter;
    console.log(`[DAPClient ${this.id}] New instance created. ID: ${this.id}`);
    this.socket = new net.Socket();
    this.buffer = "";
    this.nextSeq = 1;
    this.pendingResponses = new Map();
    this.eventQueue = new Map();
  }

  // Utility: pause for ms milliseconds.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Connect to debugpy at host:port.
  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(port, host, () => {
        // Start buffering incoming data once connected.
        this.socket.on("data", (data: Buffer) => this.handleData(data));
        resolve();
      });
      this.socket.on("error", (err) => reject(err));
    });
  }

  // Send a DAP message with Content-Length
  sendMessage(message: DAPMessage): void {
    message.seq = this.nextSeq++;
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    const data = header + json;
    this.socket.write(data);

    console.log(
      `--> Sent (seq ${message.seq}, cmd: ${message.command}): ${json}`,
    );
  }

  // Wait for a DAP "response" matching request_seq.
  waitForResponse(seq: number, timeout = 10000): Promise<DAPMessage> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (this.pendingResponses.has(seq)) {
          const msg = this.pendingResponses.get(seq)!;
          this.pendingResponses.delete(seq);
          clearInterval(interval);
          resolve(msg);
        } else if (Date.now() - start > timeout) {
          clearInterval(interval);
          reject(new Error(`Timeout waiting for response to seq ${seq}`));
        }
      }, 100);
    });
  }

  // Wait for a DAP "event" by name, checking our local queue.
  waitForEvent(eventName: string, timeout = 10000): Promise<DAPMessage> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      // 1) Function to see if we already have such an event waiting.
      const checkQueue = () => {
        const existing = this.eventQueue.get(eventName);
        if (existing && existing.length > 0) {
          // Dequeue the first event
          const msg = existing.shift()!;
          resolve(msg);
          if (timer) clearTimeout(timer);
        }
      };

      // 2) Start by checking if there's already an event queued.
      checkQueue();

      // 3) If not found, we listen for further events.
      if (!timer) {
        // We'll also set a once-listener for the event.
        const onEvent = () => {
          checkQueue();
        };

        this.on(eventName, onEvent);

        // 4) Timeout if not found soon.
        timer = setTimeout(() => {
          this.off(eventName, onEvent);
          reject(new Error(`Timeout waiting for event ${eventName}`));
        }, timeout);
      }
    });
  }

  // The main data handler for receiving DAP messages over the socket.
  private handleData(data: Buffer): void {
    this.buffer += data.toString("utf8");

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/);
      if (!match) {
        this.emit("error", new Error("No Content-Length header found"));
        return;
      }

      const length = parseInt(match[1], 10);
      const totalMessageLength = headerEnd + 4 + length;
      if (this.buffer.length < totalMessageLength) break;

      // Extract the body and remove it from the buffer
      const body = this.buffer.slice(headerEnd + 4, totalMessageLength);
      this.buffer = this.buffer.slice(totalMessageLength);

      let msg: DAPMessage;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        console.error("Error parsing JSON message", e);
        continue;
      }

      // Check for debug events to update paused state and current location.
      if (msg.type === "event") {
        console.log(
          `[DAPClient ${this.id}] Event received:`,
          msg.event,
          "with payload:",
          msg.body,
        );
        if (msg.event === "stopped") {
          this.isPaused = true;
          this.terminated = false;
          console.log(
            `[DAPClient ${this.id}] Processing 'stopped' event. isPaused:`,
            this.isPaused,
            "terminated:",
            this.terminated,
          );
          if (msg.body?.threadId) {
            this.currentThreadId = msg.body.threadId;
            console.log(
              `[DAPClient ${this.id}] Got threadId:`,
              this.currentThreadId,
              " - fetching stack trace...",
            );
            this.stackTrace(msg.body.threadId, 0, 1)
              .then((stackResp) => {
                const frames = stackResp.body?.stackFrames;
                if (frames && frames.length > 0) {
                  const topFrame = frames[0];
                  const file = topFrame.source?.path;
                  const line = topFrame.line;
                  this.currentPausedLocation = { file, line };
                  console.log(
                    `[DAPClient ${this.id}] Updated currentPausedLocation:`,
                    this.currentPausedLocation,
                  );
                  this.emit(
                    "pausedLocationUpdated",
                    this.currentPausedLocation,
                  );
                } else {
                  console.log(
                    `[DAPClient ${this.id}] No stack frames received on 'stopped' event.`,
                  );
                }
              })
              .catch((err) => {
                console.error("Error fetching stack trace on stop event:", err);
              });
          }
        } else if (msg.event === "continued" || msg.event === "exited") {
          this.isPaused = false;
          this.currentPausedLocation = null;
          this.currentThreadId = null;
          console.log(
            `[DAPClient ${this.id}] Processing '${msg.event}' event. isPaused set to`,
            this.isPaused,
          );
        } else if (msg.event === "terminated") {
          this.isPaused = false;
          this.currentPausedLocation = null;
          this.currentThreadId = null;
          this.terminated = true;
          console.log(
            `[DAPClient ${this.id}] Processing 'terminated' event. terminated set to`,
            this.terminated,
          );
        }
      }

      // Store "response" messages so that waitForResponse can find them.
      if (msg.type === "response" && msg.request_seq) {
        this.pendingResponses.set(msg.request_seq, msg);
      }

      // If it's an event push into eventQueue.
      if (msg.type === "event" && msg.event) {
        if (!this.eventQueue.has(msg.event)) {
          this.eventQueue.set(msg.event, []);
        }
        this.eventQueue.get(msg.event)!.push(msg);
        // Also emit the event live.
        this.emit(msg.event, msg);
        console.log("Emitted event:", msg.event);
      }

      // Emit message event for logging.
      this.emit("message", msg);
      console.log("<-- Received:", msg);
    }
  }

  //
  //  HIGHER-LEVEL REQUEST METHODS
  //

  async initialize(): Promise<DAPMessage> {
    const initSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "initialize",
      arguments: {
        adapterID: "python",
        clientID: "dap_test_client",
        clientName: "DAP Test",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: true,
        supportsEvaluateForHovers: true,
      },
    };
    this.sendMessage(req);
    return this.waitForResponse(initSeq);
  }

  async attach(host: string, port: number): Promise<void> {
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "attach",
      arguments: { host, port },
    };
    this.sendMessage(req);
    // Sleep a bit to mimic python script logic.
    await this.sleep(200);
    // Wait for "initialized" event.
    await this.waitForEvent("initialized");
  }

  async setBreakpoints(
    filePath: string,
    breakpoints: Array<{ line: number }>,
  ): Promise<DAPMessage> {
    const bpSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "setBreakpoints",
      arguments: {
        source: {
          path: filePath,
          name: path.basename(filePath),
        },
        breakpoints,
        sourceModified: false,
      },
    };
    this.sendMessage(req);
    return this.waitForResponse(bpSeq);
  }

  async configurationDone(): Promise<DAPMessage> {
    const confSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "configurationDone",
      arguments: {},
    };
    this.sendMessage(req);
    return this.waitForResponse(confSeq);
  }

  async continue(threadId: number): Promise<DAPMessage> {
    const contSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "continue",
      arguments: { threadId },
    };
    this.sendMessage(req);
    return this.waitForResponse(contSeq);
  }

  async stackTrace(
    threadId: number,
    startFrame = 0,
    levels = 1,
  ): Promise<DAPMessage> {
    const stSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "stackTrace",
      arguments: { threadId, startFrame, levels },
    };
    this.sendMessage(req);
    return this.waitForResponse(stSeq);
  }

  async evaluate(expression: string, frameId?: number): Promise<DAPMessage> {
    const evalSeq = this.nextSeq;
    const args: any = { expression, context: "hover" };
    if (frameId) {
      args.frameId = frameId;
    }
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "evaluate",
      arguments: args,
    };
    this.sendMessage(req);
    return this.waitForResponse(evalSeq);
  }

  // Next == step over
  async next(threadId: number): Promise<DAPMessage> {
    const nextReqSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "next",
      arguments: { threadId },
    };
    this.sendMessage(req);
    return this.waitForResponse(nextReqSeq);
  }

  async stepIn(threadId: number): Promise<DAPMessage> {
    const reqSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "stepIn",
      arguments: { threadId },
    };
    this.sendMessage(req);
    return this.waitForResponse(reqSeq);
  }

  async stepOut(threadId: number): Promise<DAPMessage> {
    const reqSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "stepOut",
      arguments: { threadId },
    };
    this.sendMessage(req);
    return this.waitForResponse(reqSeq);
  }

  async terminate(): Promise<DAPMessage> {
    const termSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "terminate",
      arguments: { restart: false },
    };
    this.sendMessage(req);
    return this.waitForResponse(termSeq);
  }

  // Close the TCP socket.
  close(): void {
    this.socket.end();
  }
}
