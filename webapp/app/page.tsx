"use client";

import { useState, useEffect, useRef } from "react";
import { FileTree } from "@/components/FileTree";
import { MonacoEditorWrapper } from "@/components/MonacoEditor";
import { ChatInterface } from "@/components/ChatInterface";
import { DebugToolbar } from "@/components/DebugToolbar";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { OutputViewer } from "@/components/OutputViewer";

const aPy = {
  name: "a.py",
  content: `def add_numbers(a, b):
    total = a + b
    return total

def compute_fibonacci(n):
    if n <= 0:
        return []
    elif n == 1:
        return [0]
    fib_sequence = [0, 1]
    for i in range(2, n):
        next_val = fib_sequence[i - 1] + fib_sequence[i - 2]
        fib_sequence.append(next_val)
    return fib_sequence

def main():
    print("Starting test script for debugger step-through...")
    a, b = 3, 4
    print("Adding numbers:", a, "and", b)
    result = add_numbers(a, b)
    print("Result of add_numbers:", result)
    n = 10
    print("Computing Fibonacci sequence for first", n, "terms")
    fib_series = compute_fibonacci(n)
    print("Fibonacci sequence:", fib_series)
    print("Test script finished.")

if __name__ == '__main__':
    main()
`,
};

const initialFiles = [aPy];

export interface IBreakpoint {
  line: number;
  verified?: boolean;
}

export default function Home() {
  const [files, setFiles] = useState(initialFiles);
  const [selectedFile, setSelectedFile] = useState(files[0]);

  // Breakpoint handling: keep separate queued vs. active sets
  const [queuedBreakpoints, setQueuedBreakpoints] = useState<IBreakpoint[]>([]);
  const [activeBreakpoints, setActiveBreakpoints] = useState<IBreakpoint[]>([]);

  const [isDebugSessionActive, setIsDebugSessionActive] = useState(false);
  const [debugStatus, setDebugStatus] = useState("inactive");

  // Execution status state
  const [executionLine, setExecutionLine] = useState<number | null>(null);
  const [executionFile, setExecutionFile] = useState<string | null>(null);

  // Helper: merge queued + active so Monaco shows all of them
  function mergeBreakpoints(
    queued: IBreakpoint[],
    active: IBreakpoint[],
  ): IBreakpoint[] {
    const merged = new Map<number, IBreakpoint>();
    // Add queued first
    for (const bp of queued) {
      merged.set(bp.line, bp);
    }
    // Overwrite with active (in case of duplication)
    for (const bp of active) {
      merged.set(bp.line, bp);
    }
    return Array.from(merged.values());
  }

  const handleFileSelect = (file: { name: string; content: string }) => {
    setSelectedFile(file);
  };

  const handleFileChange = (newContent: string) => {
    const updatedFiles = files.map((file) =>
      file.name === selectedFile.name ? { ...file, content: newContent } : file,
    );
    setFiles(updatedFiles);
    setSelectedFile({ ...selectedFile, content: newContent });
  };

  // Toggle a breakpoint
  const handleBreakpointChange = (lineNumber: number) => {
    if (!isDebugSessionActive) {
      // If debug session is NOT active, modify the queuedBreakpoints only
      setQueuedBreakpoints((currentQueued) => {
        const existingBp = currentQueued.find((bp) => bp.line === lineNumber);
        if (!existingBp) {
          return [...currentQueued, { line: lineNumber }];
        }
        return currentQueued.filter((bp) => bp.line !== lineNumber);
      });
    } else {
      // If debug session is active, we update activeBreakpoints AND call the API
      setActiveBreakpoints((currentActive) => {
        const existingBp = currentActive.find((bp) => bp.line === lineNumber);
        let newBreakpoints: IBreakpoint[];
        if (!existingBp) {
          newBreakpoints = [...currentActive, { line: lineNumber }];
        } else {
          newBreakpoints = currentActive.filter((bp) => bp.line !== lineNumber);
        }

        fetch("/api/debug?action=setBreakpoints", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            breakpoints: newBreakpoints,
            filePath: selectedFile.name,
          }),
        })
          .then((response) => response.json())
          .then((data) => {
            if (data.breakpoints) {
              // Update verified states
              setActiveBreakpoints((current) =>
                current.map((bp) => {
                  const verifiedBp = data.breakpoints.find(
                    (vbp: IBreakpoint) => vbp.line === bp.line,
                  );
                  return verifiedBp
                    ? { ...bp, verified: verifiedBp.verified }
                    : bp;
                }),
              );
            }
          })
          .catch((error) =>
            console.error("Failed to update active breakpoints:", error),
          );

        return newBreakpoints;
      });
    }
  };

  // Called when user presses "Launch Debug Session"
  const handleDebugSessionStart = () => {
    if (isDebugSessionActive) {
      console.log("Debug session is already launching or active, skipping");
      return;
    }
    setIsDebugSessionActive(true);

    fetch("/api/debug?action=launch", { method: "POST" })
      .then((resp) => resp.json())
      .then(() => {
        // Now that we are active, send queued breakpoints if any
        setQueuedBreakpoints((qbp) => {
          if (qbp.length > 0) {
            setActiveBreakpoints(qbp);
            console.log("SET BREAKPOINTS FROM HERE 2");
            fetch("/api/debug?action=setBreakpoints", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                breakpoints: qbp,
                filePath: selectedFile.name,
              }),
            })
              .then((resp) => resp.json())
              .then((data) => {
                if (data.breakpoints) {
                  setActiveBreakpoints((current) =>
                    current.map((bp) => {
                      const verified = data.breakpoints.find(
                        (vbp: IBreakpoint) => vbp.line === bp.line,
                      )?.verified;
                      return { ...bp, verified };
                    }),
                  );
                }
              })
              .catch((err) =>
                console.error("Failed to set queued breakpoints:", err),
              );
          }

          return [];
        });
      })
      .catch((error) =>
        console.error("Failed launching debug session:", error),
      );
  };

  // Poll debug status if a debug session is active
  useEffect(() => {
    if (isDebugSessionActive) {
      const pollInterval = setInterval(async () => {
        try {
          const res = await fetch("/api/debug?action=status");
          const data = await res.json();
          if (data.status === "paused" && data.file && data.line) {
            setExecutionFile(data.file);
            setExecutionLine(data.line);
            setDebugStatus("paused");
          } else if (data.status === "terminated") {
            setExecutionFile(null);
            setExecutionLine(null);
            setDebugStatus("terminated");
          } else if (data.status === "running") {
            setExecutionFile(null);
            setExecutionLine(null);
            setDebugStatus("running");
          } else {
            setExecutionFile(null);
            setExecutionLine(null);
            setDebugStatus("inactive");
          }
        } catch (e) {
          console.error("Failed polling debug status:", e);
        }
      }, 1500);
      return () => clearInterval(pollInterval);
    } else {
      setExecutionFile(null);
      setExecutionLine(null);
      setDebugStatus("inactive");
    }
  }, [isDebugSessionActive]);

  return (
    <div className="h-screen flex flex-col">
      <ResizablePanelGroup direction="horizontal">
        {/* Left side: file tree, debug toolbar, output */}
        <ResizablePanel defaultSize={20} minSize={15}>
          <ResizablePanelGroup direction="vertical">
            {/* FileTree */}
            <ResizablePanel defaultSize={40}>
              <div className="h-full border-b">
                <FileTree files={files} onSelectFile={handleFileSelect} />
              </div>
            </ResizablePanel>
            {/* DebugToolbar */}
            <ResizablePanel defaultSize={30}>
              <div className="h-full">
                <DebugToolbar
                  onDebugSessionStart={handleDebugSessionStart}
                  debugStatus={debugStatus}
                />
              </div>
            </ResizablePanel>
            {/* OutputViewer */}
            <ResizablePanel defaultSize={30}>
              <div className="h-full">
                <OutputViewer />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        {/* Right side: Editor and ChatInterface */}
        <ResizablePanel defaultSize={80}>
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={60}>
              <div className="h-full">
                <MonacoEditorWrapper
                  content={selectedFile.content}
                  language="python"
                  onChange={handleFileChange}
                  // Important: pass the merged breakpoints
                  breakpoints={mergeBreakpoints(
                    queuedBreakpoints,
                    activeBreakpoints,
                  )}
                  onBreakpointChange={handleBreakpointChange}
                  executionFile={executionFile}
                  executionLine={executionLine}
                />
              </div>
            </ResizablePanel>
            {/* ChatInterface */}
            <ResizablePanel defaultSize={40}>
              <ChatInterface
                files={files}
                onSetBreakpoint={handleBreakpointChange}
                onLaunch={handleDebugSessionStart}
                onContinue={() => {
                  fetch("/api/debug?action=continue", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId: 1 }),
                  })
                    .then((res) => res.json())
                    .then((data) => console.log("Continue result:", data))
                    .catch((err) => console.error("Continue failed:", err));
                }}
                onEvaluate={async (expression: string) => {
                  const res = await fetch("/api/debug?action=evaluate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ expression, threadId: 1 }),
                  });
                  const data = await res.json();
                  return data.result;
                }}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
