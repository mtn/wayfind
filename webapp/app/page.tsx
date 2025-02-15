"use client";

import { useState, useEffect, useRef } from "react";
import { FileTree } from "@/components/FileTree";
import { MonacoEditorWrapper } from "@/components/MonacoEditor";
import { ChatInterface } from "@/components/ChatInterface";
import { DebugToolbar } from "@/components/DebugToolbar";
import WatchExpressions from "@/components/WatchExpressions";
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

  // Breakpoint handling: separate queued vs. active sets
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
    for (const bp of queued) {
      merged.set(bp.line, bp);
    }
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
  const isDebugSessionActiveRef = useRef(isDebugSessionActive);
  useEffect(() => {
    isDebugSessionActiveRef.current = isDebugSessionActive;
  }, [isDebugSessionActive]);
  const handleBreakpointChange = (lineNumber: number) => {
    if (!isDebugSessionActiveRef.current) {
      setQueuedBreakpoints((currentQueued) => {
        const existingBp = currentQueued.find((bp) => bp.line === lineNumber);
        if (!existingBp) {
          return [...currentQueued, { line: lineNumber }];
        }
        return currentQueued.filter((bp) => bp.line !== lineNumber);
      });
    } else {
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
  const handleDebugSessionStart = async () => {
    if (isDebugSessionActive) {
      console.log("Debug session is already launching or active, skipping");
      return;
    }
    setIsDebugSessionActive(true);
    try {
      const launchResp = await fetch("/api/debug?action=launch", {
        method: "POST",
      });
      const launchData = await launchResp.json();
      console.log("Launch response:", launchData);
      if (queuedBreakpoints.length > 0) {
        setActiveBreakpoints(queuedBreakpoints);
        console.log("Setting queued breakpoints...", queuedBreakpoints);
        const bpResp = await fetch("/api/debug?action=setBreakpoints", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            breakpoints: queuedBreakpoints,
            filePath: selectedFile.name,
          }),
        });
        const bpData = await bpResp.json();
        console.log("Breakpoint response:", bpData);
        if (bpData.breakpoints) {
          setActiveBreakpoints((current) =>
            current.map((bp) => {
              const verified = bpData.breakpoints.find(
                (vbp: IBreakpoint) => vbp.line === bp.line,
              )?.verified;
              return { ...bp, verified };
            }),
          );
        }
        setQueuedBreakpoints([]);
      }
      const confResp = await fetch("/api/debug?action=configurationDone", {
        method: "POST",
      });
      const confData = await confResp.json();
      console.log("configurationDone response:", confData);
    } catch (error) {
      console.error("Failed launching debug session:", error);
    }
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

  const evaluateExpression = async (expression: string) => {
    const res = await fetch("/api/debug?action=evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression, threadId: 1 }),
    });
    const data = await res.json();
    return data.result;
  };

  return (
    <div className="h-screen flex flex-col">
      <ResizablePanelGroup direction="horizontal">
        {/* Left side: contains three vertical sections (each 1/3 of height) */}
        <ResizablePanel defaultSize={33} minSize={10}>
          <ResizablePanelGroup direction="vertical">
            {/* Section 1: FileTree */}
            <ResizablePanel defaultSize={40} minSize={10}>
              <div className="h-full border-b">
                <FileTree files={files} onSelectFile={handleFileSelect} />
              </div>
            </ResizablePanel>
            {/* Section 2: Debug Panel (DebugToolbar + WatchExpressions) */}
            <ResizablePanel defaultSize={40} minSize={10}>
              <div className="h-full border-b flex flex-col">
                <div className="flex-none">
                  <DebugToolbar
                    onDebugSessionStart={handleDebugSessionStart}
                    debugStatus={debugStatus}
                  />
                </div>
                <div className="flex-none">
                  <WatchExpressions
                    isPaused={debugStatus === "paused"}
                    onEvaluate={evaluateExpression}
                  />
                </div>
              </div>
            </ResizablePanel>
            {/* Section 3: Outputs */}
            <ResizablePanel defaultSize={20} minSize={10}>
              <div className="h-full">
                <OutputViewer />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        {/* Right side: Editor and ChatInterface */}
        <ResizablePanel defaultSize={67}>
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={60}>
              <div className="h-full">
                <MonacoEditorWrapper
                  content={selectedFile.content}
                  language="python"
                  onChange={handleFileChange}
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
                onEvaluate={evaluateExpression}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
