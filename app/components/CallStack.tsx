"use client";

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// If you have a global place for threadId, or pass it in as a prop, whichever is relevant:
type CallStackProps = {
  debugStatus: string;
  threadId: number; // or omit if you always use a known default
};

interface Frame {
  id: number;
  name: string;
  line: number;
  column?: number;
  file?: string;
}

export function CallStack({ debugStatus, threadId }: CallStackProps) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchCallStack() {
    setLoading(true);
    try {
      const result = await invoke<Frame[]>("get_call_stack", {
        threadId: threadId,
      });
      setFrames(result || []);
    } catch (e) {
      console.error("Failed to fetch call stack", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Whenever debugStatus is "paused", fetch the call stack.
    if (debugStatus === "paused") {
      fetchCallStack();
    }
  }, [debugStatus]);

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
        <ul className="text-sm space-y-1">
          {frames.map((frame) => (
            <li key={frame.id}>
              <strong>{frame.name}</strong> at line {frame.line}
              {frame.file && <span> in {frame.file}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div>No call stack data available.</div>
      )}
    </div>
  );
}
