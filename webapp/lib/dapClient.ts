import net from "net";
import { EventEmitter } from "events";
import path from "path";

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
  private socket: net.Socket;
  private buffer: string;
  private nextSeq: number;
  // This map stores responses keyed by request_seq.
  private pendingResponses: Map<number, DAPMessage>;

  constructor() {
    super();
    this.socket = new net.Socket();
    this.buffer = "";
    this.nextSeq = 1;
    this.pendingResponses = new Map();
  }

  // Utility: pause for ms milliseconds.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Wait for a specific event name once, with a timeout in ms.
  waitForEvent(eventName: string, timeout = 10000): Promise<DAPMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(eventName, listener);
        reject(new Error(`Timeout waiting for event ${eventName}`));
      }, timeout);

      const listener = (data: DAPMessage) => {
        clearTimeout(timer);
        resolve(data);
      };

      // We emit("eventName", data) below in handleData for any event.
      // So here, we listen once for eventName.
      this.once(eventName, listener);
    });
  }

  // Connect to the debugpy socket at host:port.
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

  // Send a DAP message by prepending Content-Length headers, with no wait for response.
  sendMessage(message: DAPMessage): void {
    message.seq = this.nextSeq++;
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    const data = header + json;
    this.socket.write(data);

    // For visibility in logs:
    console.log(
      `--> Sent (seq ${message.seq}, cmd: ${message.command}): ${json}`,
    );
  }

  // Wait for a DAP response matching the given request_seq within the specified timeout.
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

  // -- The main loop that buffers incoming data and emits DAP messages. --
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

      // Extract the body and remove it from the buffer.
      const body = this.buffer.slice(headerEnd + 4, totalMessageLength);
      this.buffer = this.buffer.slice(totalMessageLength);

      // Parse the JSON message.
      let msg: DAPMessage;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        console.error("Error parsing JSON message", e);
        continue;
      }

      // If it's a response, store it under pendingResponses so waitForResponse can pick it up.
      if (msg.type === "response" && msg.request_seq) {
        this.pendingResponses.set(msg.request_seq, msg);
      }

      // We also emit an event with the raw message so that logs/debugging can see it.
      // But for DAP "event" messages, we also emit by the event name, so waitForEvent can catch them.
      this.emit("message", msg);
      if (msg.type === "event" && msg.event) {
        // e.g. "initialized", "stopped", etc.
        this.emit(msg.event, msg);
      }

      console.log("<-- Received:", msg);
    }
  }

  //
  //  -- Below are the higher-level request methods that mimic the Python script. --
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

  /**
   * Send the "attach" request. In the Python script, the code:
   *   - sends attach,
   *   - sleeps 0.2s,
   *   - waits for "initialized" event,
   *   - sets breakpoints / config done,
   *   - THEN tries to retrieve attach response with a short timeout.
   *
   * So here we just do the attach request + short sleep, and return the seq.
   * The caller can do the rest of the steps in the same order as Python.
   */
  async attach(host: string, port: number): Promise<void> {
    const attachSeq = this.nextSeq;
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "attach",
      arguments: { host, port },
    };
    this.sendMessage(req);

    // Sleep like the Python script does
    await this.sleep(200);

    // Wait for initialized event
    await this.waitForEvent("initialized");

    // Note: We don't wait for attach response here
    // The caller can use tryGetAttachResponse later if needed
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

  /**
   * Try to retrieve the attach response with a short timeout, similarly to the Python code,
   * which does:
   *   try:
   *       attach_resp = wait_for_response(attach_seq)
   *   except TimeoutError:
   *       attach_resp = None
   */
  async tryGetAttachResponse(
    attachSeq: number,
    timeout = 1000,
  ): Promise<DAPMessage | null> {
    try {
      const resp = await this.waitForResponse(attachSeq, timeout);
      return resp;
    } catch (err) {
      console.log(
        "No attach response received (expected in some configurations).",
      );
      return null;
    }
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

  // Close the TCP socket.
  close(): void {
    this.socket.end();
  }
}
