"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface DebugToolbarProps {
  ws: WebSocket | null;
  onDebugSessionStart: () => void;
  onDebuggerStopped?: (line: number | null) => void;
}

export function DebugToolbar({
  ws,
  onDebugSessionStart,
  onDebuggerStopped,
}: DebugToolbarProps) {
  const [sessionStarted, setSessionStarted] = useState(false);
  const [expression, setExpression] = useState("");
  const [log, setLog] = useState<string[]>([]);

  // Helper to send a message over WS.
  function sendMessage(action: string, payload: any): number | null {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const requestId = Date.now(); // simple unique requestId
      const message = { action, payload, requestId };
      ws.send(JSON.stringify(message));
      return requestId;
    } else {
      console.error("WebSocket is not open. Cannot send message:", action);
      setLog((prev) => [...prev, "Error: WebSocket is not open."]);
      return null;
    }
  }

  async function handleLaunch() {
    const reqId = sendMessage("launch", {});
    if (reqId) {
      setLog((prev) => [...prev, "Launching debug session..."]);
      setSessionStarted(true);
      onDebugSessionStart();
    }
  }

  async function handleEvaluate() {
    if (!sessionStarted) {
      setLog((prev) => [...prev, "Cannot evaluate: Debug session not started"]);
      return;
    }
    const reqId = sendMessage("evaluate", { expression, threadId: 1 });
    if (reqId) {
      setLog((prev) => [...prev, `Sent evaluate request: ${expression}`]);
    }
  }

  async function handleContinue() {
    if (!sessionStarted) {
      setLog((prev) => [...prev, "Cannot continue: Debug session not started"]);
      return;
    }
    const reqId = sendMessage("continue", { threadId: 1 });
    if (reqId) {
      setLog((prev) => [...prev, "Sent continue command"]);
      // The backend will later broadcast a "stopped" event,
      // which will trigger a stackTrace request and update pausedLineNumber.
    }
  }

  return (
    <div className="p-4 border-t">
      <div className="flex flex-wrap gap-4 mb-4">
        <Button onClick={handleLaunch} disabled={sessionStarted}>
          Launch Debug Session
        </Button>
        {sessionStarted && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Enter expression"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                className="border rounded px-2 py-1"
              />
              <Button onClick={handleEvaluate}>Evaluate</Button>
            </div>
            <Button onClick={handleContinue}>Continue</Button>
          </>
        )}
      </div>
      <div className="bg-gray-50 p-2 rounded h-40 overflow-auto text-xs">
        {log.map((entry, idx) => (
          <div key={idx} className="border-b py-0.5">
            {entry}
          </div>
        ))}
      </div>
    </div>
  );
}
