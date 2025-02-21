"use client";

import { useEffect, useState } from "react";

interface OutputViewerProps {
  sessionId: string | null;
}

export function OutputViewer({ sessionId }: OutputViewerProps) {
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    if (!sessionId) return;

    console.log("OutputViewer mounted");
    const eventSource = new EventSource(
      `/api/debug/outputs?sessionId=${sessionId}`,
    );

    eventSource.onopen = (event) => {
      console.log("SSE connection for output streaming opened", event);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setOutput((prev) => [...prev, data]);
      } catch (_err) {
        setOutput((prev) => [...prev, event.data]);
      }
    };

    eventSource.onerror = (err) => {
      console.error("EventSource failed:", err);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [sessionId]);

  return (
    <div className="p-2 bg-gray-100 h-full overflow-auto text-xs flex flex-col">
      <h2 className="font-bold mb-2">Outputs</h2>
      {output.map((line, index) => (
        <div key={index} className="whitespace-pre-wrap">
          {line}
        </div>
      ))}
    </div>
  );
}
