import crypto from "crypto";
import { DAPClient } from "./dapClient";
import { spawn, ChildProcess } from "child_process";

interface DebugSession {
  id: string;
  dapClient: DAPClient | null;
  pythonProcess: ChildProcess | null;
  configurationDoneSent: boolean;
  lastAccessed: number;
  outputBuffer: string[];
}

export class SessionManager {
  private sessions: Map<string, DebugSession>;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.sessions = new Map();
    // Clean up inactive sessions every 5 minutes
    this.cleanupInterval = setInterval(
      () => this.cleanupInactiveSessions(),
      5 * 60 * 1000,
    );
  }

  createSession(): string {
    const sessionId = crypto.randomBytes(32).toString("hex");
    this.sessions.set(sessionId, {
      id: sessionId,
      dapClient: null,
      pythonProcess: null,
      configurationDoneSent: false,
      lastAccessed: Date.now(),
      outputBuffer: [],
    });
    return sessionId;
  }

  getSession(sessionId: string): DebugSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessed = Date.now();
    }
    return session;
  }

  async cleanupSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.pythonProcess) {
        session.pythonProcess.kill();
      }
      if (session.dapClient) {
        session.dapClient.close();
      }
      this.sessions.delete(sessionId);
    }
  }

  private cleanupInactiveSessions() {
    const now = Date.now();
    const inactiveThreshold = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastAccessed > inactiveThreshold) {
        this.cleanupSession(sessionId);
      }
    }
  }
}

export const sessionManager = new SessionManager();
