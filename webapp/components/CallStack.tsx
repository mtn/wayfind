"use client";

import { useState, useEffect } from "react";

export function CallStack() {
  const [frames, setFrames] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchCallStack() {
    setLoading(true);
    try {
      const res = await fetch("/api/debug?action=stackTrace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: 1 }),
      });
      const data = await res.json();
      setFrames(data.stackFrames || []);
    } catch (e) {
      console.error("Failed to fetch call stack", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchCallStack();
  }, []);

  return (
    <div className="p-2">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold">Call Stack</h3>
        <button
          onClick={fetchCallStack}
          className="text-xs text-blue-500 hover:underline"
        >
          Refresh
        </button>
      </div>
      {loading ? (
        <div>Loading call stack…</div>
      ) : frames.length > 0 ? (
        <ul className="text-sm">
          {frames.map((frame: any) => (
            <li key={frame.id}>
              {frame.name} at line {frame.line}
            </li>
          ))}
        </ul>
      ) : (
        <div>No call stack data available.</div>
      )}
    </div>
  );
}

CallStack.displayName = "CallStack";
