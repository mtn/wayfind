import { useEffect, useState } from "react";

export function OutputViewer() {
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    const intervalId = setInterval(async () => {
      try {
        const res = await fetch("/api/debug/outputs");
        if (res.ok) {
          const json = await res.json();
          if (json.output && json.output.length > 0) {
            setOutput((prev) => [...prev, ...json.output]);
          }
        }
      } catch (err) {
        console.error("Error fetching output:", err);
      }
    }, 1500);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="p-2 bg-gray-100 h-full overflow-auto text-xs flex flex-col">
      <h2 className="font-bold mb-2">Outputs</h2>
      {output.map((line, index) => (
        // The whitespace-pre-wrap class causes newlines (\n) in your text to be rendered properly.
        <div key={index} className="whitespace-pre-wrap">
          {line}
        </div>
      ))}
    </div>
  );
}
