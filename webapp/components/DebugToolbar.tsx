"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Play,
  ArrowRightCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  RotateCcw,
  Square,
} from "lucide-react";

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

  // Compute session status based on debugStatus
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
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error launching session: ${errMsg}`, "dap");
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
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error evaluating: ${errMsg}`, "dap");
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
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error continuing execution: ${errMsg}`, "dap");
    }
  }

  // New handlers for additional debugging actions.
  async function handleStepOver() {
    try {
      const res = await fetch("/api/debug?action=stepOver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      addLogEntry(`Step Over result: ${JSON.stringify(data.result)}`, "dap");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error stepping over: ${errMsg}`, "dap");
    }
  }

  async function handleStepInto() {
    try {
      const res = await fetch("/api/debug?action=stepInto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      addLogEntry(`Step Into result: ${JSON.stringify(data.result)}`, "dap");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error stepping into: ${errMsg}`, "dap");
    }
  }

  async function handleStepOut() {
    try {
      const res = await fetch("/api/debug?action=stepOut", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      addLogEntry(`Step Out result: ${JSON.stringify(data.result)}`, "dap");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error stepping out: ${errMsg}`, "dap");
    }
  }

  async function handleRestart() {
    try {
      const res = await fetch("/api/debug?action=restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      addLogEntry(`Restart result: ${JSON.stringify(data.result)}`, "dap");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error restarting: ${errMsg}`, "dap");
    }
  }

  async function handleStop() {
    try {
      const res = await fetch("/api/debug?action=stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      addLogEntry(`Stop result: ${JSON.stringify(data.result)}`, "dap");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addLogEntry(`Error stopping: ${errMsg}`, "dap");
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
        {!isSessionActive && (
          <Button onClick={handleLaunch}>Launch Debug Session</Button>
        )}
        {isSessionActive && (
          <>
            <div className="flex items-center gap-2">
              {/* Expression input/evaluate remains as desired */}
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
            {/* New icon‑based debugger controls */}
            <div className="flex items-center gap-2">
              <Button
                onClick={handleContinue}
                disabled={!isPaused}
                title="Continue"
              >
                <Play className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleStepOver}
                disabled={!isPaused}
                title="Step Over"
              >
                <ArrowRightCircle className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleStepInto}
                disabled={!isPaused}
                title="Step Into"
              >
                <ArrowDownCircle className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleStepOut}
                disabled={!isPaused}
                title="Step Out"
              >
                <ArrowUpCircle className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleRestart}
                disabled={!isPaused}
                title="Restart"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button onClick={handleStop} disabled={!isPaused} title="Stop">
                <Square className="h-4 w-4" />
              </Button>
            </div>
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
