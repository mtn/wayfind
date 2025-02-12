"use client";

import { useState, useEffect } from "react";
import { flushSync } from "react-dom";
import { FileTree } from "@/components/FileTree";
import { MonacoEditorWrapper } from "@/components/MonacoEditor";
import { ChatInterface } from "@/components/ChatInterface";
import { DebugToolbar } from "@/components/DebugToolbar";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { OutputViewer } from "@/components/OutputViewer";

const aPy = {
  name: "a.py",
  content: `#!/usr/bin/env python3

def add_numbers(a, b):
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
  const [breakpoints, setBreakpoints] = useState<IBreakpoint[]>([]);
  const [isDebugSessionActive, setIsDebugSessionActive] = useState(false);
  const [debugStatus, setDebugStatus] = useState("inactive");

  // Execution status
  const [executionLine, setExecutionLine] = useState<number | null>(null);
  const [executionFile, setExecutionFile] = useState<string | null>(null);

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
    console.log(
      "[handleBreakpointChange] Toggling breakpoint at line:",
      lineNumber,
      "| isDebugSessionActive:",
      isDebugSessionActive,
    );

    // flushSync ensures breakpoints updates immediately
    flushSync(() => {
      setBreakpoints((currentBreakpoints) => {
        const existingBp = currentBreakpoints.find(
          (bp) => bp.line === lineNumber,
        );
        let newBreakpoints: IBreakpoint[];
        if (!existingBp) {
          newBreakpoints = [...currentBreakpoints, { line: lineNumber }];
        } else {
          newBreakpoints = currentBreakpoints.filter(
            (bp) => bp.line !== lineNumber,
          );
        }

        console.log(
          "[handleBreakpointChange] Updated breakpoints array (client state):",
          newBreakpoints,
        );

        // If debug session is active, send them immediately
        if (isDebugSessionActive) {
          console.log(
            "[handleBreakpointChange] Debug session active, sending breakpoints to /api/debug...",
          );
          fetch("/api/debug?action=setBreakpoints", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              breakpoints: newBreakpoints,
              filePath: selectedFile.name,
            }),
          })
            .then((response) => {
              console.log(
                "[handleBreakpointChange] setBreakpoints response:",
                response,
              );
              return response.json();
            })
            .then((data) => {
              console.log(
                "[handleBreakpointChange] setBreakpoints JSON body:",
                data,
              );
              if (data.breakpoints) {
                setBreakpoints((current) =>
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
              console.error(
                "[handleBreakpointChange] Failed to set breakpoints on the server:",
                error,
              ),
            );
        } else {
          console.log(
            "[handleBreakpointChange] Debug session not active; breakpoints not sent to server yet.",
          );
        }
        return newBreakpoints;
      });
    });
  };

  // Start debug session (only launches / does not set breakpoints)
  const handleDebugSessionStart = () => {
    console.log("[handleDebugSessionStart] Starting debug session...");
    setIsDebugSessionActive(true);

    // Launch debug session
    fetch("/api/debug?action=launch", { method: "POST" })
      .then((resp) => {
        console.log(
          "[handleDebugSessionStart] /api/debug?action=launch responded:",
          resp,
        );
        return resp.json();
      })
      .then((data) => {
        console.log("[handleDebugSessionStart] Launch response data:", data);
      })
      .catch((error) =>
        console.error(
          "[handleDebugSessionStart] Failed launching debug session:",
          error,
        ),
      );
  };

  // This effect runs each time breakpoints or isDebugSessionActive changes.
  // If session is active and we have breakpoints, we'll send them up.
  useEffect(() => {
    if (isDebugSessionActive && breakpoints.length > 0) {
      console.log(
        "[breakpoints/useEffect] Session is active with > 0 breakpoints, sending to server...",
        breakpoints,
      );
      fetch("/api/debug?action=setBreakpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          breakpoints,
          filePath: selectedFile.name,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          console.log(
            "[breakpoints/useEffect] setBreakpoints response data:",
            data,
          );
          if (data.breakpoints) {
            // Update verified flags
            setBreakpoints((current) =>
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
        .catch((err) => {
          console.error(
            "[breakpoints/useEffect] Error setting breakpoints:",
            err,
          );
        });
    }
  }, [isDebugSessionActive, breakpoints, selectedFile.name]);

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
            // "inactive" or some unknown state
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
      // Reset when inactive
      setExecutionFile(null);
      setExecutionLine(null);
      setDebugStatus("inactive");
    }
  }, [isDebugSessionActive]);

  return (
    <div className="h-screen flex flex-col">
      <ResizablePanelGroup direction="horizontal">
        {/* Left side: vertical group with FileTree, DebugToolbar, and OutputViewer */}
        <ResizablePanel defaultSize={20} minSize={15}>
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={40}>
              <div className="h-full border-b">
                <FileTree files={files} onSelectFile={handleFileSelect} />
              </div>
            </ResizablePanel>
            <ResizablePanel defaultSize={30}>
              <div className="h-full">
                <DebugToolbar
                  onDebugSessionStart={handleDebugSessionStart}
                  debugStatus={debugStatus}
                />
              </div>
            </ResizablePanel>
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
                  breakpoints={breakpoints}
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
                  // For "continue", re-use your existing functionality
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
                  // For evaluation, call your debug API and return the result
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
