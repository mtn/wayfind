"use client";

import { useState, useEffect, useCallback } from "react";
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
    main()`,
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
  const [pausedLineNumber, setPausedLineNumber] = useState<number | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);

  // Simple function to connect and try reconnecting if necessary.
  const connectWebSocket = useCallback(() => {
    console.log("Attempting to connect to WebSocket...");
    const socket = new WebSocket("ws://localhost:8080");
    socket.onopen = () => {
      console.log("WebSocket connected");
      setWs(socket);
    };
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Check for broadcasted events.
        if (msg.type === "event" && msg.payload) {
          const event = msg.payload;
          console.log("Received event over WS:", event);
          if (event.event === "stopped") {
            // When a 'stopped' event arrives, send a stackTrace request.
            const stackReq = {
              action: "stackTrace",
              payload: { threadId: event.body.threadId },
              requestId: Date.now(),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(stackReq));
            }
          }
        }
        // Check if this is a response with stackFrames.
        if (msg.requestId && msg.result && msg.result.stackFrames) {
          const frames = msg.result.stackFrames;
          if (frames && frames.length > 0) {
            setPausedLineNumber(frames[0].line);
          }
        }
      } catch (err) {
        console.error("Error processing WS message:", err);
      }
    };
    socket.onerror = (e) => {
      console.error("WebSocket error:", e);
    };
    socket.onclose = (e) => {
      console.error("WebSocket closed:", e);
      setWs(null);
      // Attempt reconnect after a delay.
      setTimeout(() => {
        connectWebSocket();
      }, 3000);
    };
  }, []);

  useEffect(() => {
    connectWebSocket();
  }, [connectWebSocket]);

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
    console.log("Toggling breakpoint at line", lineNumber);
    setBreakpoints((currentBreakpoints) => {
      const exists = currentBreakpoints.find((bp) => bp.line === lineNumber);
      return exists
        ? currentBreakpoints.filter((bp) => bp.line !== lineNumber)
        : [...currentBreakpoints, { line: lineNumber }];
    });
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
                  pausedLineNumber={pausedLineNumber}
                />
              </div>
            </ResizablePanel>
            <ResizablePanel defaultSize={20}>
              <ChatInterface files={files} />
            </ResizablePanel>
            <ResizablePanel defaultSize={20}>
              <DebugToolbar
                ws={ws}
                onDebugSessionStart={() => {
                  console.log("Debug session starting...");
                }}
                onDebuggerStopped={(line) => {
                  setPausedLineNumber(line);
                }}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
