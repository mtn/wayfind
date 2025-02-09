"use client";

import { useState } from "react";
import { FileTree } from "@/components/FileTree";
import { MonacoEditorWrapper } from "@/components/MonacoEditor";
import { ChatInterface } from "@/components/ChatInterface";
import { DebugToolbar } from "@/components/DebugToolbar";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

const aPy = {
  name: "a.py",
  content: `#!/usr/bin/env python3

def add_numbers(a, b):
    # Adds two numbers and returns the result.
    total = a + b
    return total

def compute_fibonacci(n):
    # Computes the first n numbers in the Fibonacci sequence.
    # Handles the case when n is 0 or 1.
    if n <= 0:
        return []
    elif n == 1:
        return [0]

    fib_sequence = [0, 1]
    for i in range(2, n):
        next_val = fib_sequence[i - 1] + fib_sequence[i - 2]
        # Debug point: check the next value before appending.
        fib_sequence.append(next_val)
    return fib_sequence

def main():
    print("Starting test script for debugger step-through...")

    # Test addition function.
    a, b = 3, 4
    print("Adding numbers:", a, "and", b)
    result = add_numbers(a, b)
    print("Result of add_numbers:", result)

    # Test Fibonacci function.
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
  enabled: boolean;
}

export default function Home() {
  const [files, setFiles] = useState(initialFiles);
  const [selectedFile, setSelectedFile] = useState(files[0]);
  const [breakpoints, setBreakpoints] = useState<IBreakpoint[]>([]);
  const [isDebugSessionActive, setIsDebugSessionActive] = useState(false);

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

  const handleBreakpointChange = async (lineNumber: number) => {
    const existingBp = breakpoints.find((bp) => bp.line === lineNumber);
    let newBreakpoints: IBreakpoint[];

    if (!existingBp) {
      // Add new breakpoint (enabled by default)
      newBreakpoints = [...breakpoints, { line: lineNumber, enabled: true }];
    } else if (existingBp.enabled) {
      // Disable existing breakpoint
      newBreakpoints = breakpoints.map((bp) =>
        bp.line === lineNumber ? { ...bp, enabled: false } : bp,
      );
    } else {
      // Remove disabled breakpoint
      newBreakpoints = breakpoints.filter((bp) => bp.line !== lineNumber);
    }

    setBreakpoints(newBreakpoints);

    // If debug session is active, send the updated breakpoints to the server
    if (isDebugSessionActive) {
      try {
        const response = await fetch("/api/debug?action=setBreakpoints", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Only send enabled breakpoints to the debug adapter
            breakpoints: newBreakpoints.filter((bp) => bp.enabled),
            filePath: selectedFile.name,
          }),
        });
        const data = await response.json();
        if (data.breakpoints) {
          // Merge verification status with our local state
          const mergedBreakpoints = newBreakpoints.map((bp) => {
            const verifiedBp = data.breakpoints.find(
              (vbp: IBreakpoint) => vbp.line === bp.line,
            );
            return verifiedBp && bp.enabled
              ? { ...bp, verified: verifiedBp.verified }
              : bp;
          });
          setBreakpoints(mergedBreakpoints);
        }
      } catch (error) {
        console.error("Failed to update breakpoints:", error);
      }
    }
  };

  const handleDebugSessionStart = () => {
    setIsDebugSessionActive(true);
  };

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
                />
              </div>
            </ResizablePanel>
            <ResizablePanel defaultSize={20}>
              <ChatInterface files={files} />
            </ResizablePanel>
            <ResizablePanel defaultSize={20}>
              <DebugToolbar
                onDebugSessionStart={handleDebugSessionStart}
                breakpoints={breakpoints}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
