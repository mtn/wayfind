"use client";

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export function OutputViewer() {
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    // Listen for program output
    const unlistenOutput = listen("program-output", (event) => {
      setOutput((prev) => [...prev, event.payload as string]);
    });

    // Listen for program errors
    const unlistenError = listen("program-error", (event) => {
      setOutput((prev) => [...prev, `[ERROR] ${event.payload as string}`]);
    });

    return () => {
      // Cleanup listeners
      unlistenOutput.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, []);

  return (
    <div className="p-2 bg-gray-100 h-full overflow-auto text-xs flex flex-col">
      <h2 className="font-bold mb-2">Outputs</h2>
      <div className="font-mono">
        {output.map((line, index) => (
          <div key={index} className="whitespace-pre-wrap">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
