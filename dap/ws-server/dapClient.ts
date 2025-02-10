import net from "net";
import { EventEmitter } from "events";
import path from "path";

// Used internally for requests that have not yet received a response.
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
  private pendingResponses: Map<number, DAPMessage>;
  private eventQueue: Map<string, DAPMessage[]>;

  // Optional callback that higher–level code (e.g. our WebSocket server)
  // can assign to broadcast DAP events.
  public broadcastFn?: (msg: DAPMessage) => void;

  constructor() {
    super();
    this.socket = new net.Socket();
    this.buffer = "";
    this.nextSeq = 1;
    this.pendingResponses = new Map();
    this.eventQueue = new Map();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Connect to debugpy at host:port
  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(port, host, () => {
        this.socket.on("data", (data: Buffer) => this.handleData(data));
        resolve();
      });
      this.socket.on("error", (err) => reject(err));
    });
  }

  // Send a DAP message with Content-Length header.
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

  // Wait for a specific response matching the requestSeq.
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

  // Wait for a DAP event by name.
  waitForEvent(eventName: string, timeout = 10000): Promise<DAPMessage> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const checkQueue = () => {
        const existing = this.eventQueue.get(eventName);
        if (existing && existing.length > 0) {
          const msg = existing.shift()!;
          resolve(msg);
          if (timer) clearTimeout(timer);
        }
      };

      checkQueue();

      if (!timer) {
        const onEvent = () => {
          checkQueue();
        };
        this.on(eventName, onEvent);

        timer = setTimeout(() => {
          this.off(eventName, onEvent);
          reject(new Error(`Timeout waiting for event ${eventName}`));
        }, timeout);
      }
    });
  }

  // Main data handler for incoming data from the debugpy socket.
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

      const body = this.buffer.slice(headerEnd + 4, totalMessageLength);
      this.buffer = this.buffer.slice(totalMessageLength);

      let msg: DAPMessage;
      try {
        msg = JSON.parse(body);
      } catch (e) {
        console.error("Error parsing JSON message", e);
        continue;
      }

      // If it is a response, store it in pendingResponses.
      if (msg.type === "response" && msg.request_seq) {
        this.pendingResponses.set(msg.request_seq, msg);
      }

      // For events, enqueue them and
      if (msg.type === "event" && msg.event) {
        if (!this.eventQueue.has(msg.event)) {
          this.eventQueue.set(msg.event, []);
        }
        this.eventQueue.get(msg.event)!.push(msg);
        this.emit(msg.event, msg);

        // Call the broadcast callback if it is set.
        if (this.broadcastFn) {
          this.broadcastFn(msg);
        }
      }

      // Emit the generic message for logging and further processing.
      this.emit("message", msg);
      console.log("<-- Received:", msg);
    }
  }

  // HIGHER-LEVEL REQUEST METHODS

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
    await this.sleep(200);
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

  async tryGetAttachResponse(
    attachSeq: number,
    timeout = 1000,
  ): Promise<DAPMessage | null> {
    try {
      const resp = await this.waitForResponse(attachSeq, timeout);
      return resp;
    } catch (err) {
      console.log("No attach response received", err);
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

  close(): void {
    this.socket.end();
  }
}
