"use client";

import { useState, useEffect, useRef } from "react";
import { FileTree } from "@/components/FileTree";
import { MonacoEditorWrapper } from "@/components/MonacoEditor";
import { ChatInterface } from "@/components/ChatInterface";
import DebugToolbar from "@/components/DebugToolbar";
import WatchExpressions, {
  WatchExpressionsHandle,
} from "@/components/WatchExpressions";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { OutputViewer } from "@/components/OutputViewer";
import { CallStack } from "@/components/CallStack";

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

  // New state variable to store the session token.
  const [sessionToken, setSessionToken] = useState<string>("");

  // Breakpoint handling: separate queued vs. active sets.
  const [queuedBreakpoints, setQueuedBreakpoints] = useState<IBreakpoint[]>([]);
  const [activeBreakpoints, setActiveBreakpoints] = useState<IBreakpoint[]>([]);

  const [isDebugSessionActive, setIsDebugSessionActive] = useState(false);
  const [debugStatus, setDebugStatus] = useState("inactive");

  // Execution status state.
  const [executionLine, setExecutionLine] = useState<number | null>(null);
  const [executionFile, setExecutionFile] = useState<string | null>(null);

  // A state to accumulate debug log messages, which will display only in the Status tab.
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const addLog = (msg: string) => setDebugLog((prev) => [...prev, msg]);

  // Create a ref for WatchExpressions.
  const watchExpressionsRef = useRef<WatchExpressionsHandle>(null);

  // State to manage the selected tab in the debug panel.
  // We offer three tabs: Status, Watches, and Call Stack.
  const [selectedTab, setSelectedTab] = useState("status");

  // Function to force evaluation: called by status updates.
  const forceWatchEvaluation = () => {
    if (watchExpressionsRef.current) {
      watchExpressionsRef.current.reevaluate();
    }
  };

  // Helper: merge queued + active so Monaco shows all breakpoints.
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

  // Toggle a breakpoint.
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
        fetch("/api/debug?action=setBreakpoints&token=" + sessionToken, {
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

  // Called when the user presses "Launch Debug Session".
  const handleDebugSessionStart = async (force: boolean = false) => {
    if (!force && isDebugSessionActive && debugStatus !== "terminated") {
      addLog("Debug session is already launching or active, skipping");
      return;
    }

    // Create a local copy of breakpoints we want to set in the new session
    let breakpointsToSet: IBreakpoint[] = [];
    if (force || debugStatus === "terminated" || !isDebugSessionActive) {
      // Combine active breakpoints into the queued ones for the new session
      breakpointsToSet = [...activeBreakpoints]; // Keep a local copy

      // Update state for next render
      setQueuedBreakpoints(activeBreakpoints);
      setActiveBreakpoints([]);
      setSessionToken("");
    }

    setIsDebugSessionActive(true);
    addLog("Launching debug session...");
    try {
      const launchResp = await fetch("/api/debug?action=launch", {
        method: "POST",
      });
      const launchData = await launchResp.json();
      setSessionToken(launchData.token);
      addLog(`Session launched: ${launchData.message}`);

      // Use our local copy plus any existing queued breakpoints
      const allBreakpoints = [...breakpointsToSet, ...queuedBreakpoints];

      if (allBreakpoints.length > 0) {
        addLog(`Setting breakpoints: ${JSON.stringify(allBreakpoints)}`);
        const bpResp = await fetch(
          "/api/debug?action=setBreakpoints&token=" + launchData.token,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              breakpoints: allBreakpoints,
              filePath: selectedFile.name,
            }),
          },
        );
        const bpData = await bpResp.json();
        addLog(`Breakpoint response: ${JSON.stringify(bpData)}`);
        if (bpData.breakpoints) {
          setActiveBreakpoints(
            allBreakpoints.map((bp) => {
              const verified = bpData.breakpoints.find(
                (vbp: IBreakpoint) => vbp.line === bp.line,
              )?.verified;
              return { ...bp, verified };
            }),
          );
          setQueuedBreakpoints([]); // Clear queued breakpoints after setting them
        }
      }

      const confResp = await fetch(
        "/api/debug?action=configurationDone&token=" + launchData.token,
        {
          method: "POST",
        },
      );
      const confData = await confResp.json();
      addLog(`configurationDone response: ${JSON.stringify(confData)}`);
    } catch (error) {
      addLog(
        `Failed launching debug session: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  };

  // Listen for debug status updates using Server-Sent Events (SSE) if a debug session is active.
  useEffect(() => {
    if (isDebugSessionActive && sessionToken) {
      const eventSource = new EventSource(
        "/api/debug?action=status&token=" + sessionToken,
      );
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.status === "paused" && data.file && data.line) {
            setExecutionFile(data.file);
            setExecutionLine(data.line);
            setDebugStatus("paused");
            forceWatchEvaluation();
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
        } catch (error) {
          console.error("Error parsing status event data:", error);
        }
      };
      eventSource.onerror = (e) => {
        console.error("Status SSE encountered an error:", e);
        eventSource.close();
      };
      return () => {
        eventSource.close();
      };
    } else {
      setExecutionFile(null);
      setExecutionLine(null);
      setDebugStatus("inactive");
    }
  }, [isDebugSessionActive, sessionToken]);

  const evaluateExpression = async (expression: string) => {
    try {
      const res = await fetch(
        "/api/debug?action=evaluate&token=" + sessionToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expression, threadId: 1 }),
        },
      );
      const data = await res.json();
      return data.result;
    } catch (e) {
      addLog(`Evaluation error: ${e instanceof Error ? e.message : e}`);
      return "";
    }
  };

  // onContinue callback for ChatInterface.
  const handleContinue = () => {
    fetch("/api/debug?action=continue&token=" + sessionToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: 1 }),
    })
      .then((res) => res.json())
      .then((data) => {
        addLog(`Continue result: ${JSON.stringify(data.result)}`);
      })
      .catch((err) => {
        addLog(`Continue failed: ${err}`);
        console.error("Continue failed:", err);
      });
  };

  return (
    <div className="h-screen flex flex-col">
      <ResizablePanelGroup direction="horizontal">
        {/* Left side: three vertical sections (40:40:20) */}
        <ResizablePanel defaultSize={33} minSize={10}>
          <ResizablePanelGroup direction="vertical">
            {/* Section 1: FileTree */}
            <ResizablePanel defaultSize={40} minSize={10}>
              <div className="h-full border-b">
                <FileTree files={files} onSelectFile={handleFileSelect} />
              </div>
            </ResizablePanel>
            {/* Section 2: Debug Panel – Controls always visible with tabs below */}
            <ResizablePanel defaultSize={40} minSize={10}>
              <div className="h-full border-b flex flex-col">
                {/* Always-visible debugger controls */}
                <div className="flex-none">
                  <DebugToolbar
                    onDebugSessionStart={handleDebugSessionStart}
                    debugStatus={debugStatus}
                    sessionToken={sessionToken}
                    addLog={addLog}
                  />
                </div>
                {/* Tab Header */}
                <div className="flex-none border-b">
                  <div className="flex">
                    <button
                      onClick={() => setSelectedTab("status")}
                      className={`flex-1 py-2 text-sm ${
                        selectedTab === "status"
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                    >
                      Status
                    </button>
                    <button
                      onClick={() => setSelectedTab("watches")}
                      className={`flex-1 py-2 text-sm ${
                        selectedTab === "watches"
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                    >
                      Watches
                    </button>
                    <button
                      onClick={() => setSelectedTab("callstack")}
                      className={`flex-1 py-2 text-sm ${
                        selectedTab === "callstack"
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                    >
                      Call Stack
                    </button>
                  </div>
                </div>
                {/* Tab Content – for the Status tab, display only the log messages */}
                <div className="flex-1 overflow-auto p-2">
                  {selectedTab === "status" && (
                    <div className="h-full overflow-auto border rounded-md bg-background">
                      <div className="p-2 border-b font-bold">Debug Log</div>
                      <div className="p-2 space-y-1 font-mono text-xs">
                        {debugLog.map((msg, i) => (
                          <div key={i} className="whitespace-pre-wrap">
                            {msg}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedTab === "watches" && (
                    <WatchExpressions
                      ref={watchExpressionsRef}
                      isPaused={debugStatus === "paused"}
                      onEvaluate={evaluateExpression}
                    />
                  )}
                  {selectedTab === "callstack" && (
                    <CallStack token={sessionToken} />
                  )}
                </div>
              </div>
            </ResizablePanel>
            {/* Section 3: Outputs */}
            <ResizablePanel defaultSize={20} minSize={10}>
              <div className="h-full">
                <OutputViewer sessionToken={sessionToken} />
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
                onContinue={handleContinue}
                onEvaluate={evaluateExpression}
                sessionToken={sessionToken}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
