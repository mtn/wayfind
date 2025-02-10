"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { IBreakpoint } from "@/app/page";

interface DebugToolbarProps {
  onDebugSessionStart: () => void;
  breakpoints: IBreakpoint[];
}

export function DebugToolbar({
  onDebugSessionStart,
  breakpoints,
}: DebugToolbarProps) {
  const [sessionStarted, setSessionStarted] = useState(false);
  const [expression, setExpression] = useState("");
  const [log, setLog] = useState<string[]>([]);

  // Handler to launch the debug session.
  async function handleLaunch() {
    try {
      setLog((prev) => [...prev, "Launching debug session..."]);
      const res = await fetch("/api/debug?action=launch", { method: "POST" });
      const data = await res.json();
      setLog((prev) => [...prev, `Session launched: ${data.message}`]);
      setSessionStarted(true);
      onDebugSessionStart();
    } catch (err: any) {
      setLog((prev) => [...prev, `Error launching session: ${err.message}`]);
    }
  }

  // Handler to evaluate an expression.
  async function handleEvaluate() {
    if (!sessionStarted) {
      setLog((prev) => [...prev, "Cannot evaluate: Debug session not started"]);
      return;
    }

    try {
      const res = await fetch("/api/debug?action=evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression, threadId: 1 }),
      });
      const data = await res.json();
      setLog((prev) => [...prev, `Evaluation result: ${data.result}`]);
    } catch (err: any) {
      setLog((prev) => [...prev, `Error evaluating: ${err.message}`]);
    }
  }

  // Handler to continue execution.
  async function handleContinue() {
    if (!sessionStarted) {
      setLog((prev) => [...prev, "Cannot continue: Debug session not started"]);
      return;
    }

    try {
      const res = await fetch("/api/debug?action=continue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      setLog((prev) => [
        ...prev,
        `Continue result: ${JSON.stringify(data.result)}`,
      ]);
    } catch (err: any) {
      setLog((prev) => [...prev, `Error continuing execution: ${err.message}`]);
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
