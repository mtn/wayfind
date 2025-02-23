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
import { FileEntry, InMemoryFileSystem } from "@/lib/fileSystem";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface IBreakpoint {
  line: number;
  verified?: boolean;
  file?: string;
}

const cPy: FileEntry = {
  name: "c.py",
  content: `from d import add_numbers

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
  path: "/c.py",
  type: "file",
};

const dPy: FileEntry = {
  name: "d.py",
  content: `
def add_numbers(a, b):
  total = a + b
  return total`,
  path: "/d.py",
  type: "file",
};

const initialFiles = [cPy, dPy];

export default function Home() {
  const [fs, setFs] = useState(() => new InMemoryFileSystem(initialFiles));
  const [files, setFiles] = useState<FileEntry[]>(initialFiles);
  const [selectedFile, setSelectedFile] = useState<FileEntry>(files[0]);

  const selectedFileRef = useRef(selectedFile);
  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  useEffect(() => {
    async function loadFiles() {
      const entries = await fs.getEntries("/");
      setFiles(entries);
    }
    loadFiles();
  }, [fs]);

  const [sessionToken, setSessionToken] = useState<string>("");

  const [queuedBreakpoints, setQueuedBreakpoints] = useState<IBreakpoint[]>([]);
  const [activeBreakpoints, setActiveBreakpoints] = useState<IBreakpoint[]>([]);

  const [isDebugSessionActive, setIsDebugSessionActive] = useState(false);
  const [debugStatus, setDebugStatus] = useState("inactive");

  const [executionLine, setExecutionLine] = useState<number | null>(null);
  const [executionFile, setExecutionFile] = useState<string | null>(null);

  const [debugLog, setDebugLog] = useState<string[]>([]);
  const addLog = (msg: string) => setDebugLog((prev) => [...prev, msg]);

  const watchExpressionsRef = useRef<WatchExpressionsHandle>(null);

  const [selectedTab, setSelectedTab] = useState("status");

  const forceWatchEvaluation = () => {
    if (watchExpressionsRef.current) {
      watchExpressionsRef.current.reevaluate();
    }
  };

  function mergeBreakpoints(
    queued: IBreakpoint[],
    active: IBreakpoint[],
  ): IBreakpoint[] {
    const merged = new Map<string, IBreakpoint>();
    for (const bp of queued) {
      if (bp.file) {
        merged.set(`${bp.file}:${bp.line}`, bp);
      }
    }
    for (const bp of active) {
      if (bp.file) {
        merged.set(`${bp.file}:${bp.line}`, bp);
      }
    }
    return Array.from(merged.values());
  }

  const handleFileSelect = async (file: FileEntry) => {
    if (file.type === "file") {
      const freshFile = await fs.getFile(file.path);
      if (freshFile) {
        setSelectedFile(freshFile);
      }
    }
  };

  const handleFileChange = async (newContent: string) => {
    await fs.updateFile(selectedFile.path, newContent);
    const entries = await fs.getEntries("/");
    setFiles(entries);
    const updatedFile = await fs.getFile(selectedFile.path);
    if (updatedFile) {
      setSelectedFile(updatedFile);
    }
  };

  const handleOpenWorkspace = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected) {
        const entries = await invoke<
          Array<{
            name: string;
            path: string;
            is_dir: boolean;
            content?: string;
          }>
        >("read_directory", {
          path: selected,
        });

        const newFiles = entries.map((entry) => ({
          name: entry.name,
          path: `/${entry.name}`,
          type: entry.is_dir ? ("directory" as const) : ("file" as const),
          content: entry.content || "",
        }));

        const newFs = new InMemoryFileSystem(newFiles);
        setFs(newFs);

        setFiles(newFiles);

        if (newFiles.length > 0) {
          const firstFile = newFiles.find((f) => f.type === "file");
          if (firstFile) {
            setSelectedFile(firstFile);
          }
        }
      }
    } catch (error) {
      console.error("Error opening workspace:", error);
    }
  };

  const isDebugSessionActiveRef = useRef(isDebugSessionActive);
  useEffect(() => {
    isDebugSessionActiveRef.current = isDebugSessionActive;
  }, [isDebugSessionActive]);

  const handleBreakpointChange = (lineNumber: number) => {
    const currentFileName = selectedFileRef.current.name;
    if (!isDebugSessionActiveRef.current) {
      setQueuedBreakpoints((currentQueued) => {
        const exists = currentQueued.some(
          (bp) => bp.line === lineNumber && bp.file === currentFileName,
        );
        if (!exists) {
          return [
            ...currentQueued,
            { line: lineNumber, file: currentFileName },
          ];
        }
        return currentQueued.filter(
          (bp) => !(bp.line === lineNumber && bp.file === currentFileName),
        );
      });
    } else {
      setActiveBreakpoints((currentActive) => {
        const exists = currentActive.some(
          (bp) => bp.line === lineNumber && bp.file === currentFileName,
        );
        const newBreakpoints = exists
          ? currentActive.filter(
              (bp) => !(bp.line === lineNumber && bp.file === currentFileName),
            )
          : [...currentActive, { line: lineNumber, file: currentFileName }];

        invoke("set_breakpoints", {
          token: sessionToken,
          breakpoints: newBreakpoints.filter(
            (bp) => bp.file === currentFileName,
          ),
          filePath: currentFileName,
        })
          .then((data: { breakpoints?: IBreakpoint[] }) => {
            if (data.breakpoints) {
              setActiveBreakpoints((current) =>
                current.map((bp) => {
                  if (bp.file !== currentFileName) return bp;
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

  const handleDebugSessionStart = async (force: boolean = false) => {
    if (!force && isDebugSessionActive && debugStatus !== "terminated") {
      addLog("Debug session is already launching or active, skipping");
      return;
    }

    setIsDebugSessionActive(true);
    addLog("Launching debug session...");

    try {
      await invoke("launch_program", {
        scriptPath: selectedFile.path,
      });

      addLog("Debug session launched successfully");

      const unlistenStatus = await listen("debug-status", (event) => {
        const status = event.payload as {
          status: string;
          file?: string;
          line?: number;
        };
        setDebugStatus(status.status.toLowerCase());

        if (status.status === "Running") {
          setExecutionFile(null);
          setExecutionLine(null);
        } else if (status.status === "Terminated") {
          setExecutionFile(null);
          setExecutionLine(null);
          setIsDebugSessionActive(false);
        }
      });

      return () => {
        unlistenStatus();
      };
    } catch (error) {
      addLog(
        `Failed launching debug session: ${
          error instanceof Error ? error.message : error
        }`,
      );
      setIsDebugSessionActive(false);
    }
  };

  const evaluateExpression = async (expression: string) => {
    try {
      const result = await invoke<string>("evaluate_expression", {
        expression,
      });
      return result;
    } catch (e) {
      addLog(`Evaluation error: ${e instanceof Error ? e.message : e}`);
      return "";
    }
  };

  const handleContinue = async () => {
    try {
      await invoke("continue_execution");
      addLog("Continuing execution");
    } catch (err) {
      addLog(`Continue failed: ${err}`);
      console.error("Continue failed:", err);
    }
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
                <FileTree
                  files={files}
                  onSelectFile={handleFileSelect}
                  onOpenWorkspace={handleOpenWorkspace}
                />
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
                  content={selectedFile.content || ""}
                  language="python"
                  onChange={handleFileChange}
                  breakpoints={mergeBreakpoints(
                    queuedBreakpoints,
                    activeBreakpoints,
                  ).filter((bp) => bp.file === selectedFile.name)}
                  onBreakpointChange={handleBreakpointChange}
                  executionFile={executionFile}
                  executionLine={executionLine}
                  currentFile={selectedFile.name}
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
