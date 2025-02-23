import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { DAPClient } from "./dapClient";

// We’ll store session data in memory, keyed by a unique token.
export interface DebugSession {
  token: string;
  dapClient: DAPClient;
  pythonProcess: ReturnType<typeof spawn>;
  configurationDoneSent: boolean;
}

// We keep them in a simple Map. In production, you might replace this with
// something more persistent (Redis, a database, etc.) if desired.
const sessions = new Map<string, DebugSession>();

function generateToken(): string {
  // This just returns a 16‑byte random hex string;
  // you can choose a different scheme if you like:
  return randomBytes(16).toString("hex");
}

export function createDebugSession(
  dapClient: DAPClient,
  pythonProcess: ReturnType<typeof spawn>,
): DebugSession {
  const token = generateToken();
  const session: DebugSession = {
    token,
    dapClient,
    pythonProcess,
    configurationDoneSent: false,
  };
  sessions.set(token, session);
  return session;
}

export function getDebugSession(token: string): DebugSession | undefined {
  return sessions.get(token);
}

export function deleteDebugSession(token: string) {
  sessions.delete(token);
}

/**
 * Utility method you might call if your debug process terminates, etc.
 * This is optional but can help keep your map clean.
 */
export function cleanUpSession(token: string) {
  const session = sessions.get(token);
  if (session) {
    try {
      session.dapClient.close();
    } catch {
      // ignore
    }
    if (session.pythonProcess) {
      session.pythonProcess.kill();
    }
    sessions.delete(token);
  }
}
