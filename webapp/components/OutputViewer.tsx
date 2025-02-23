"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/utils";

interface OutputViewerProps {
  sessionToken?: string;
}

export function OutputViewer({ sessionToken }: OutputViewerProps) {
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    console.log("OutputViewer mounted");
    let eventSource: EventSource;

    // Function to create new EventSource connection
    const connectEventSource = () => {
      const eventSourceUrl = sessionToken
        ? `/api/debug/outputs?token=${sessionToken}`
        : "/api/debug/outputs";

      eventSource = new EventSource(apiUrl(eventSourceUrl));

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
        console.error("EventSource failed - attempting reconnect in 1s");
        eventSource.close();
        setTimeout(connectEventSource, 1000);
      };
    };

    // Initial connection
    connectEventSource();

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [sessionToken]);

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
