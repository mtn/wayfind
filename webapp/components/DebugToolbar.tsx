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
  sessionToken?: string;
}

export function DebugToolbar({
  onDebugSessionStart,
  debugStatus,
  sessionToken,
}: DebugToolbarProps) {
  const [expression, setExpression] = useState("");

  // Compute session status based on debugStatus
  const isSessionActive =
    debugStatus !== "inactive" && debugStatus !== "terminated";
  const isPaused = debugStatus === "paused";

  // Build token query if available
  const tokenQuery = sessionToken ? `&token=${sessionToken}` : "";

  async function handleLaunch() {
    try {
      onDebugSessionStart();
    } catch (err: unknown) {
      console.error("Error launching session:", err);
    }
  }

  async function handleEvaluate() {
    if (!isSessionActive) {
      console.error("Cannot evaluate: Debug session not started");
      return;
    }
    try {
      const res = await fetch("/api/debug?action=evaluate" + tokenQuery, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression, threadId: 1 }),
      });
      const data = await res.json();
      console.log("Evaluation result:", data.result);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error evaluating:", errMsg);
    } finally {
      setExpression("");
    }
  }

  async function handleContinue() {
    if (!isSessionActive) {
      console.error("Cannot continue: Debug session not started");
      return;
    }
    try {
      const res = await fetch("/api/debug?action=continue" + tokenQuery, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      console.log("Continue result:", JSON.stringify(data.result));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error continuing execution:", errMsg);
    }
  }

  // New handlers for additional debugging actions.
  async function handleStepOver() {
    try {
      const res = await fetch("/api/debug?action=stepOver" + tokenQuery, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      console.log("Step Over result:", JSON.stringify(data.result));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping over:", errMsg);
    }
  }

  async function handleStepIn() {
    try {
      const res = await fetch("/api/debug?action=stepIn" + tokenQuery, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      console.log("Step Into result:", JSON.stringify(data.result));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping into:", errMsg);
    }
  }

  async function handleStepOut() {
    try {
      const res = await fetch("/api/debug?action=stepOut" + tokenQuery, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      console.log("Step Out result:", JSON.stringify(data.result));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping out:", errMsg);
    }
  }

  async function handleRestart() {
    try {
      const res = await fetch("/api/debug?action=restart" + tokenQuery, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      console.log("Restart result:", JSON.stringify(data.result));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error restarting:", errMsg);
    }
  }

  async function handleTerminate() {
    try {
      const res = await fetch("/api/debug?action=terminate" + tokenQuery, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      console.log("Stop result:", JSON.stringify(data.result));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stopping:", errMsg);
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
            {/* Icon‑based debugger controls */}
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
                onClick={handleStepIn}
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
              <Button
                onClick={handleTerminate}
                disabled={!isPaused}
                title="Stop"
              >
                <Square className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default DebugToolbar;
