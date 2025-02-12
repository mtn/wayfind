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
  const [log, setLog] = useState<DebugLogEntry[]>([]);
  const [expression, setExpression] = useState("");

  // Compute if session is active based on debugStatus
  const isSessionActive =
    debugStatus !== "inactive" && debugStatus !== "terminated";
  const isPaused = debugStatus === "paused";

  const addLogEntry = (text: string, type: "dap" | "program" = "dap") => {
    setLog((prev) => [...prev, { id: Date.now(), text, type }]);
  };

  async function handleLaunch() {
    try {
      addLogEntry("Launching debug session...", "dap");
      const res = await fetch("/api/debug?action=launch", { method: "POST" });
      const data = await res.json();
      addLogEntry(`Session launched: ${data.message}`, "dap");
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
    if (!isSessionActive) {
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
    } finally {
      setExpression("");
    }
  }

  async function handleContinue() {
    if (!isSessionActive) {
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
        <Button onClick={handleLaunch} disabled={isSessionActive}>
          Launch Debug Session
        </Button>
        {isSessionActive && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Enter expression"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleEvaluate();
                  }
                }}
                className="border rounded px-2 py-1"
                disabled={!isPaused}
              />
              <Button onClick={handleEvaluate} disabled={!isPaused}>
                Evaluate
              </Button>
            </div>
            <Button onClick={handleContinue} disabled={!isPaused}>
              Continue
            </Button>
          </>
        )}
      </div>
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
