"use client";

import { useState, useEffect, useRef, useCallback, ReactNode } from "react";
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

const initialFiles: FileEntry[] = [];

export default function Home() {
  const [fs, setFs] = useState(() => new InMemoryFileSystem(initialFiles));
  const [files, setFiles] = useState<FileEntry[]>(initialFiles);
  const [selectedFile, setSelectedFile] = useState<FileEntry | undefined>(
    undefined,
  );

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
  const [debugEngine, setDebugEngine] = useState<string>("python");

  const [queuedBreakpoints, setQueuedBreakpoints] = useState<IBreakpoint[]>([]);
  const [activeBreakpoints, setActiveBreakpoints] = useState<IBreakpoint[]>([]);

  const [isDebugSessionActive, setIsDebugSessionActive] = useState(false);
  // Updated to use canonical debug state value "notstarted"
  const [debugStatus, setDebugStatus] = useState("notstarted");
  // Add ref for tracking the latest debug status
  const debugStatusRef = useRef("notstarted");

  const [executionLine, setExecutionLine] = useState<number | null>(null);
  const [executionFile, setExecutionFile] = useState<string | null>(null);

  const [debugLog, setDebugLog] = useState<ReactNode[]>([]);
  const addLog = (msg: ReactNode) => setDebugLog((prev) => [...prev, msg]);

  const watchExpressionsRef = useRef<WatchExpressionsHandle>(null);

  const [selectedTab, setSelectedTab] = useState("status");

  // Add ref to track the last status sequence number processed
  const lastStatusSeqRef = useRef<number | null>(null);

  // Update ref whenever the state changes
  useEffect(() => {
    debugStatusRef.current = debugStatus;
  }, [debugStatus]);

  const forceWatchEvaluation = () => {
    if (watchExpressionsRef.current) {
      watchExpressionsRef.current.reevaluate();
    }
  };

  // Scroll to the bottom when debugLog changes
  const statusAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (statusAreaRef.current) {
      statusAreaRef.current.scrollTop = statusAreaRef.current.scrollHeight;
    }
  }, [debugLog]);

  function mergeBreakpoints(
    queued: IBreakpoint[],
    active: IBreakpoint[],
  ): IBreakpoint[] {
    const merged = new Map<string, IBreakpoint>();

    // Add queued breakpoints first
    for (const bp of queued) {
      if (bp.file) {
        merged.set(`${bp.file}:${bp.line}`, bp);
      }
    }

    // Then add active breakpoints, which will override queued ones with the same key
    for (const bp of active) {
      if (bp.file) {
        merged.set(`${bp.file}:${bp.line}`, {
          ...bp,
          verified: bp.verified || false, // Ensure verified property exists
        });
      }
    }

    return Array.from(merged.values());
  }

  const handleFileSelect = useCallback(
    async (file: FileEntry) => {
      if (file.type === "file") {
        const freshFile = await fs.getFile(file.path);
        if (freshFile) {
          setSelectedFile(freshFile);
          console.log(
            "Selected file full path:",
            fs.getFullPath(freshFile.path),
          );
        }
      }
    },
    [fs],
  );

  const handleFileChange = async (newContent: string) => {
    if (selectedFile === undefined) return;

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

        const newFs = new InMemoryFileSystem(newFiles, selected);
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

  // Listen for debug status events using canonical DAP events.
  useEffect(() => {
    let unlistenStatus: () => void;
    (async () => {
      unlistenStatus = await listen("debug-status", (event) => {
        console.log("Debug status event received:", event);
        const payload = event.payload as {
          status: string;
          seq: number;
          threadId?: number;
        };
        const status = payload.status.toLowerCase();

        // Only process this update if its sequence number is greater than the last one we processed
        // or if this is the first update we're receiving
        if (
          !lastStatusSeqRef.current ||
          payload.seq > lastStatusSeqRef.current
        ) {
          console.log(`Processing status update with seq ${payload.seq}`);
          lastStatusSeqRef.current = payload.seq;

          // Update both the ref and the state based on canonical events
          debugStatusRef.current = status;
          setDebugStatus(status);

          if (status === "running") {
            setExecutionFile(null);
            setExecutionLine(null);
          } else if (status === "terminated") {
            setExecutionFile(null);
            setExecutionLine(null);
            setIsDebugSessionActive(false);
          } else if (status === "paused") {
            // When paused, force watch expressions to update
            forceWatchEvaluation();

            if (payload.threadId) {
              invoke("get_paused_location", {
                threadId: payload.threadId,
              }).catch((err) =>
                console.error("Failed to get paused location:", err),
              );
            }
          }
        } else {
          console.log(
            `Ignoring out-of-order status update with seq ${payload.seq} (current: ${lastStatusSeqRef.current})`,
          );
        }
      });
    })();

    return () => {
      if (unlistenStatus) {
        unlistenStatus();
      }
    };
  }, []);

  // Listen for debug location events
  useEffect(() => {
    let unlistenLocation: () => void;
    (async () => {
      unlistenLocation = await listen("debug-location", (event) => {
        const payload = event.payload as {
          file: string;
          line: number;
        };

        console.log("Received debug-location event:", payload);

        // Update execution position
        setExecutionFile(payload.file);
        setExecutionLine(payload.line);

        // Extract just the filename from the path
        const fileName = payload.file.split("/").pop();

        // If the stopped file is different from the current file, try to open it
        if (fileName && fileName !== selectedFile?.name) {
          const fileEntry = files.find((f) => f.name === fileName);
          if (fileEntry) {
            handleFileSelect(fileEntry);
          } else {
            console.warn(`File ${fileName} not found in the workspace`);
          }
        }
      });
    })();

    return () => {
      if (unlistenLocation) {
        unlistenLocation();
      }
    };
  }, [files, selectedFile, handleFileSelect]);

  const handleBreakpointChange = (lineNumber: number) => {
    const currentFileName = selectedFileRef.current?.name;
    if (!currentFileName) return;

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

        // Get full file path for the current file
        if (!selectedFileRef.current) return newBreakpoints;
        const fullFilePath = fs.getFullPath(selectedFileRef.current.path);

        invoke("set_breakpoints", {
          token: sessionToken,
          breakpoints: newBreakpoints.filter(
            (bp) => bp.file === currentFileName,
          ),
          filePath: fullFilePath, // Use full path instead of just the filename
        })
          .then((data) => {
            const typedData = data as { breakpoints?: IBreakpoint[] };
            if (typedData.breakpoints) {
              // Update active breakpoints with verification status
              const verifiedBps = typedData.breakpoints.map((bp) => ({
                ...bp,
                file: currentFileName, // Ensure file is set on returned breakpoints
                verified: bp.verified !== false, // Default to true if undefined
              }));

              setActiveBreakpoints((current) => {
                // Remove current breakpoints for this file
                const othersInOtherFiles = current.filter(
                  (bp) => bp.file !== currentFileName,
                );
                // Add the newly verified breakpoints
                return [...othersInOtherFiles, ...verifiedBps];
              });
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

    if (!selectedFile || selectedFile.type !== "file") {
      addLog("No file selected to run");
      return;
    }

    setIsDebugSessionActive(true);
    addLog("Launching debug session...");
    // Reset the sequence counter when starting a new session
    lastStatusSeqRef.current = null;

    try {
      const scriptPath = fs.getFullPath(selectedFile.path);
      addLog(`Running script: ${scriptPath}`);

      await invoke("launch_debug_session", {
        scriptPath,
        debugEngine,
      });

      addLog("Debug session launched successfully");

      // Merge queued and active breakpoints and set them for the new session.
      const allBreakpoints = mergeBreakpoints(
        queuedBreakpoints,
        activeBreakpoints,
      );
      setQueuedBreakpoints([]);

      const uniqueFiles = Array.from(
        new Set(allBreakpoints.map((bp) => bp.file).filter(Boolean)),
      );
      for (const file of uniqueFiles) {
        const fileBreakpoints = allBreakpoints.filter((bp) => bp.file === file);

        // Find the FileEntry with this name to get its path
        const fileEntry = files.find((f) => f.name === file);
        if (!fileEntry) {
          addLog(`Could not find file entry for ${file}, skipping breakpoints`);
          continue;
        }

        // Get the full filesystem path
        const fullFilePath = fs.getFullPath(fileEntry.path);

        addLog(
          `Setting breakpoints for ${file} (path: ${fullFilePath}): ${JSON.stringify(fileBreakpoints)}`,
        );

        const bpResp = await invoke<{ breakpoints?: IBreakpoint[] }>(
          "set_breakpoints",
          {
            token: sessionToken,
            breakpoints: fileBreakpoints,
            filePath: fullFilePath, // Use full path instead of just the file name
          },
        );
        addLog(`Breakpoint response for ${file}: ${JSON.stringify(bpResp)}`);
        if (bpResp.breakpoints) {
          const verifiedBps = bpResp.breakpoints.map((bp) => ({
            ...bp,
            file, // Ensure file is set on returned breakpoints
            verified: bp.verified !== false, // Default to true if undefined
          }));

          setActiveBreakpoints((current) => {
            // Remove current breakpoints for this file
            const othersInOtherFiles = current.filter((bp) => bp.file !== file);
            // Add the newly verified breakpoints
            return [...othersInOtherFiles, ...verifiedBps];
          });
        }
      }

      // Only now, after setting all breakpoints, call configuration_done
      await invoke("configuration_done")
        .then((response) => {
          addLog("configurationDone: " + response);
        })
        .catch((error) => {
          addLog(
            "Failed configuration_done: " +
              (error instanceof Error ? error.message : error),
          );
        });

      // The debug-status listener is now set up early using useEffect.
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
      const result = await invoke<any>("evaluate_expression", {
        expression,
      });

      // For numeric types, try to parse the result
      let displayValue = result.result;
      if (result.type === "int" || result.type === "float") {
        const numericValue = parseFloat(result.result);
        if (!isNaN(numericValue)) {
          displayValue = numericValue;
        }
      }

      return result;
    } catch (e) {
      addLog(
        <div className="text-red-500">
          Error evaluating <strong>{expression}</strong>:{" "}
          {e instanceof Error ? e.message : String(e)}
        </div>,
      );
      return "";
    }
  };

  const handleContinue = async () => {
    try {
      await invoke("continue_execution");
      addLog("Continuing execution");
    } catch (err) {
      addLog(
        <div className="text-red-500">Continue failed: {String(err)}</div>,
      );
      console.error("Continue failed:", err);
    }
  };

  const hasWorkspace = Boolean(fs.getWorkspacePath());
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
                  selectedFilePath={selectedFile?.path}
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
                    hasWorkspace={hasWorkspace}
                    debugEngine={debugEngine}
                    onDebugEngineChange={setDebugEngine}
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
                      <div
                        ref={statusAreaRef}
                        className="p-2 space-y-1 font-mono text-xs overflow-auto"
                        style={{ maxHeight: "calc(100% - 36px)" }}
                      >
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
                    // TODO another place thread id 1 is hardcoded
                    <CallStack
                      executionFile={executionFile}
                      executionLine={executionLine}
                      threadId={1}
                    />
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
                  content={selectedFile?.content || ""}
                  language={debugEngine === "rust" ? "rust" : "python"}
                  onChange={handleFileChange}
                  breakpoints={mergeBreakpoints(
                    queuedBreakpoints,
                    activeBreakpoints,
                  ).filter((bp) => bp.file === selectedFile?.name)}
                  onBreakpointChange={handleBreakpointChange}
                  executionFile={executionFile}
                  executionLine={executionLine}
                  currentFile={selectedFile?.name}
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
