"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function DebugToolbar() {
  const [sessionStarted, setSessionStarted] = useState(false);
  const [expression, setExpression] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [breakpointLine, setBreakpointLine] = useState("20"); // default breakpoint line

  // Handler to launch the debug session.
  async function handleLaunch() {
    try {
      const res = await fetch("/api/debug?action=launch", { method: "POST" });
      const data = await res.json();
      setLog((prev) => [...prev, `Session launched: ${data.message}`]);
      setSessionStarted(true);
    } catch (err: any) {
      setLog((prev) => [...prev, `Error launching session: ${err.message}`]);
    }
  }

  // Handler to evaluate an expression.
  async function handleEvaluate() {
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
        <Button onClick={handleLaunch}>Launch Debug Session</Button>
        {/* For future enhancements, you might wire the breakpoint input to an API */}
        <div className="flex items-center gap-1">
          <label htmlFor="breakpoint">Breakpoint Line:</label>
          <input
            id="breakpoint"
            type="text"
            value={breakpointLine}
            onChange={(e) => setBreakpointLine(e.target.value)}
            className="border rounded px-1 text-sm w-16"
          />
        </div>
      </div>
      {sessionStarted && (
        <div className="flex flex-wrap gap-4 items-end mb-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="expr">Evaluate Expression:</label>
            <input
              id="expr"
              type="text"
              placeholder="Enter expression"
              value={expression}
              onChange={(e) => setExpression(e.target.value)}
              className="border rounded px-1 text-sm"
            />
          </div>
          <Button onClick={handleEvaluate}>Evaluate</Button>
          <Button onClick={handleContinue}>Continue</Button>
        </div>
      )}
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
