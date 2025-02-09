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
  socket: net.Socket;
  buffer: string;
  nextSeq: number;
  pendingResponses: Map<number, (msg: DAPMessage) => void>;

  constructor() {
    super();
    this.socket = new net.Socket();
    this.buffer = "";
    this.nextSeq = 1;
    this.pendingResponses = new Map();
  }

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(port, host, () => {
        this.socket.on("data", (data: Buffer) => this.handleData(data));
        resolve();
      });
      this.socket.on("error", (err) => {
        reject(err);
      });
    });
  }

  handleData(data: Buffer) {
    this.buffer += data.toString("utf8");
    // Look for complete messages (header ends with "\r\n\r\n")
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
      // If this is a response message, see if someone is waiting for it.
      if (msg.type === "response" && msg.request_seq) {
        const resolver = this.pendingResponses.get(msg.request_seq);
        if (resolver) {
          resolver(msg);
          this.pendingResponses.delete(msg.request_seq);
        }
      }
      this.emit("message", msg);
      console.log("<-- Received:", msg);
    }
  }

  sendMessage(message: DAPMessage): Promise<DAPMessage> {
    message.seq = this.nextSeq++;
    const json = JSON.stringify(message);
    // Construct header with Content-Length
    const data = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    // Write to the socket
    this.socket.write(data);
    console.log("--> Sent:", json);
    // Return a promise that will resolve when the response arrives
    return new Promise((resolve, reject) => {
      this.pendingResponses.set(message.seq, resolve);
      // Optional: set a timeout for the response
      setTimeout(() => {
        if (this.pendingResponses.has(message.seq)) {
          this.pendingResponses.delete(message.seq);
          reject(
            new Error(`Timeout waiting for response for seq ${message.seq}`),
          );
        }
      }, 10000);
    });
  }

  async initialize() {
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "initialize",
      arguments: {
        adapterID: "python",
        clientID: "nextjs_dap_client",
        clientName: "Next.js DAP Client",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: true,
        supportsEvaluateForHovers: true,
      },
    };
    return await this.sendMessage(req);
  }

  async attach(host: string, port: number) {
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "attach",
      arguments: {
        host,
        port,
      },
    };
    return await this.sendMessage(req);
  }

  async setBreakpoints(filePath: string, breakpoints: Array<{ line: number }>) {
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "setBreakpoints",
      arguments: {
        source: {
          path: filePath,
          name: path.basename(filePath),
        },
        breakpoints: breakpoints,
        sourceModified: false,
      },
    };
    return await this.sendMessage(req);
  }

  async configurationDone() {
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "configurationDone",
      arguments: {},
    };
    return await this.sendMessage(req);
  }

  async continue(threadId: number) {
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "continue",
      arguments: { threadId },
    };
    return await this.sendMessage(req);
  }

  async stackTrace(threadId: number, startFrame = 0, levels = 1) {
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "stackTrace",
      arguments: { threadId, startFrame, levels },
    };
    return await this.sendMessage(req);
  }

  async evaluate(expression: string, frameId?: number) {
    const args: any = {
      expression,
      context: "hover",
    };
    if (frameId) {
      args.frameId = frameId;
    }
    const req: DAPMessage = {
      seq: SEQ_UNASSIGNED,
      type: "request",
      command: "evaluate",
      arguments: args,
    };
    return await this.sendMessage(req);
  }

  close() {
    this.socket.end();
  }
}
