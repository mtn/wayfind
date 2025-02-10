"use client";

import { useState, useEffect } from "react";
import { FileTree } from "@/components/FileTree";
import { MonacoEditorWrapper } from "@/components/MonacoEditor";
import { ChatInterface } from "@/components/ChatInterface";
import { DebugToolbar } from "@/components/DebugToolbar";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

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

  // NEW: Add execution status state
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

  const handleBreakpointChange = (lineNumber: number) => {
    console.log(
      "handleBreakpointChange: toggling breakpoint at line",
      lineNumber,
    );
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
      console.log("New breakpoints array:", newBreakpoints);
      if (isDebugSessionActive) {
        console.log(
          "Debug session is active. Sending breakpoints to /api/debug?action=setBreakpoints for file:",
          selectedFile.name,
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
              "Received response from setBreakpoints endpoint",
              response,
            );
            return response.json();
          })
          .then((data) => {
            console.log("Breakpoint update response data:", data);
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
            console.error("Failed to update breakpoints:", error),
          );
      } else {
        console.log(
          "Debug session is not active; breakpoints update not sent.",
        );
      }
      return newBreakpoints;
    });
  };

  const handleDebugSessionStart = () => {
    console.log("handleDebugSessionStart: Starting debug session");
    setIsDebugSessionActive(true);
    fetch("/api/debug?action=launch", { method: "POST" })
      .then((resp) => resp.json())
      .then((data) => {
        console.log("Launch response from server:", data);
        if (breakpoints.length > 0) {
          console.log(
            "Sending pre-existing breakpoints to /api/debug?action=setBreakpoints",
          );
          fetch("/api/debug?action=setBreakpoints", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              breakpoints,
              filePath: selectedFile.name,
            }),
          })
            .then((resp) => resp.json())
            .then((setData) => {
              console.log("Set breakpoints after launch response:", setData);
              if (setData.breakpoints) {
                setBreakpoints((current) =>
                  current.map((bp) => {
                    const verifiedBp = setData.breakpoints.find(
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
              console.error("Failed to set breakpoints:", error),
            );
        }
      })
      .catch((error) =>
        console.error("Failed launching debug session:", error),
      );
  };

  // NEW: Poll debug status if a debug session is active.
  useEffect(() => {
    if (isDebugSessionActive) {
      const pollInterval = setInterval(async () => {
        try {
          const res = await fetch("/api/debug?action=status");
          const data = await res.json();
          if (data.status === "paused" && data.file && data.line) {
            setExecutionFile(data.file);
            setExecutionLine(data.line);
          } else {
            setExecutionFile(null);
            setExecutionLine(null);
          }
        } catch (e) {
          console.error("Failed polling debug status:", e);
        }
      }, 1500);
      return () => clearInterval(pollInterval);
    } else {
      setExecutionFile(null);
      setExecutionLine(null);
    }
  }, [isDebugSessionActive]);

  return (
    <div className="h-screen flex flex-col">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel defaultSize={20} minSize={15}>
          <div className="h-full border-r">
            <FileTree files={files} onSelectFile={handleFileSelect} />
          </div>
        </ResizablePanel>
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
            <ResizablePanel defaultSize={20}>
              <ChatInterface files={files} />
            </ResizablePanel>
            <ResizablePanel defaultSize={20}>
              <DebugToolbar onDebugSessionStart={handleDebugSessionStart} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
