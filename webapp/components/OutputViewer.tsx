"use client";

import { useEffect, useState } from "react";

export function OutputViewer() {
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    console.log("OutputViewer mounted");
    const sessionToken = localStorage.getItem("sessionToken") || "";
    const eventSourceUrl = sessionToken
      ? `/api/debug/outputs?token=${sessionToken}`
      : "/api/debug/outputs";
    const eventSource = new EventSource(eventSourceUrl);

    eventSource.onopen = (event) => {
      console.log("SSE connection for output streaming opened", event);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setOutput((prev) => [...prev, data]);
      } catch {
        setOutput((prev) => [...prev, event.data]);
      }
    };

    eventSource.onerror = () => {
      console.error("EventSource failed:");
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
