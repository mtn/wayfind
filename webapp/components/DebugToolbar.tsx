"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface DebugLogEntry {
  id: number;
  text: string;
  type: "dap" | "program";
}

interface DebugToolbarProps {
  onDebugSessionStart: () => void;
  debugStatus?: string;
}

export function DebugToolbar({
  onDebugSessionStart,
  debugStatus,
}: DebugToolbarProps) {
  // Instead of an array of strings, use an array of log objects
  const [log, setLog] = useState<DebugLogEntry[]>([]);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [expression, setExpression] = useState("");

  // Utility function for appending a log entry.
  const addLogEntry = (text: string, type: "dap" | "program" = "dap") => {
    setLog((prev) => [...prev, { id: Date.now(), text, type }]);
  };

  async function handleLaunch() {
    try {
      addLogEntry("Launching debug session...", "dap");
      const res = await fetch("/api/debug?action=launch", { method: "POST" });
      const data = await res.json();
      addLogEntry(`Session launched: ${data.message}`, "dap");
      setSessionStarted(true);
      onDebugSessionStart();
    } catch (err: unknown) {
      if (err instanceof Error) {
        addLogEntry(`Error launching session: ${err.message}`, "dap");
      } else {
        addLogEntry(`Unknown error launching session: ${err}`, "dap");
      }
    }
  }

  async function handleEvaluate() {
    if (!sessionStarted) {
      addLogEntry("Cannot evaluate: Debug session not started", "dap");
      return;
    }
    try {
      const res = await fetch("/api/debug?action=evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression, threadId: 1 }),
      });
      const data = await res.json();
      addLogEntry(`Evaluation result: ${data.result}`, "dap");
    } catch (err: unknown) {
      if (err instanceof Error) {
        addLogEntry(`Error evaluating: ${err.message}`, "dap");
      } else {
        addLogEntry(`Unknown error evaluating: ${err}`, "dap");
      }
    }
  }

  async function handleContinue() {
    if (!sessionStarted) {
      addLogEntry("Cannot continue: Debug session not started", "dap");
      return;
    }
    try {
      const res = await fetch("/api/debug?action=continue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      addLogEntry(`Continue result: ${JSON.stringify(data.result)}`, "dap");
    } catch (err: unknown) {
      if (err instanceof Error) {
        addLogEntry(`Error continuing execution: ${err.message}`, "dap");
      } else {
        addLogEntry(`Unknown error continuing execution: ${err}`, "dap");
      }
    }
  }

  return (
    <div className="flex flex-col h-full p-4 border-t">
      {/* Debug session status indicator */}
      <div className="mb-2">
        <strong>Status:</strong>{" "}
        {debugStatus === "terminated" ? (
          <span className="text-red-600">Terminated</span>
        ) : (
          <span>{debugStatus}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-4 mb-4">
        <Button
          onClick={handleLaunch}
          disabled={sessionStarted || debugStatus === "terminated"}
        >
          Launch Debug Session
        </Button>
        {sessionStarted && debugStatus !== "terminated" && (
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
      {/* Log area now takes up available vertical space with flex-1 */}
      <div className="flex-1 bg-gray-50 p-2 rounded overflow-auto text-xs">
        {log.map((entry) => (
          <div key={entry.id} className="border-b py-0.5">
            {entry.type === "dap" ? <strong>{entry.text}</strong> : entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default DebugToolbar;
