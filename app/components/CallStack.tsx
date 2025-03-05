"use client";

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Frame {
  id: number;
  name: string;
  line: number;
  column?: number;
  file?: string;
}

type CallStackProps = {
  // Instead of debugStatus, we use executionLine and executionFile.
  executionLine: number | null;
  executionFile: string | null;
  // Optionally, you could pass threadId.
  threadId: number;
};

export function CallStack({
  executionLine,
  executionFile,
  threadId,
}: CallStackProps) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchCallStack = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<Frame[]>("get_call_stack", {
        threadId,
      });
      setFrames(result || []);
    } catch (e) {
      console.error("Failed to fetch call stack", e);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  // Trigger refresh when executionLine or executionFile change.
  useEffect(() => {
    // Only trigger if you have valid execution info – you can tune this condition.
    if (executionLine !== null && executionFile !== null) {
      fetchCallStack();
    }
  }, [executionLine, executionFile, threadId, fetchCallStack]);

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
