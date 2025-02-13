"use client";

import { useEffect, useState } from "react";

export function OutputViewer() {
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    console.log("OutputViewer mounted");
    const eventSource = new EventSource("/api/debug/outputs");

    eventSource.onopen = (event) => {
      console.log("SSE connection for output streaming opened", event);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setOutput((prev) => [...prev, data]);
      } catch (err) {
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
  }, []);

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
