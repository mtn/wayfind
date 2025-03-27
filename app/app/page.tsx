"use client";

import { useState, useEffect, useRef, useCallback, ReactNode } from "react";
import type { EvaluationResult } from "@/components/DebugToolbar";
import { FileTree } from "@/components/FileTree";
import { MonacoEditorWrapper } from "@/components/MonacoEditor";
import { ChatInterface } from "@/components/ChatInterface";
import DebugToolbar from "@/components/DebugToolbar";
import FileOpener from "@/components/FileOpener";
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
import { cpSync } from "node:fs";

// TODO try and make these types non-optional
export interface IBreakpoint {
  line: number;
  verified?: boolean;
  // Path relative to the workspace root
  file?: string;
}

interface LoadedFileEntry {
  name: string;
  path: string;
  content: string | null;
  is_dir: boolean;
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

  const [debugEngine, setDebugEngine] = useState<string>("python");
  const [rustBinaryPath, setRustBinaryPath] = useState<string>(
    "~/Documents/workspace/scratch/zed/target/debug/zed",
  );

  const [queuedBreakpoints, setQueuedBreakpoints] = useState<IBreakpoint[]>([]);
  const [activeBreakpoints, setActiveBreakpoints] = useState<IBreakpoint[]>([]);

  // Add refs for tracking breakpoints
  const queuedBreakpointsRef = useRef<IBreakpoint[]>([]);
  const activeBreakpointsRef = useRef<IBreakpoint[]>([]);

  // Keep refs in sync with state -- should not be necessary but would be annoying to debug...
  // Ideally this implementation can be improved.
  useEffect(() => {
    queuedBreakpointsRef.current = queuedBreakpoints;
  }, [queuedBreakpoints]);

  useEffect(() => {
    activeBreakpointsRef.current = activeBreakpoints;
  }, [activeBreakpoints]);

  const [isDebugSessionActive, setIsDebugSessionActive] = useState(false);
  // Updated to use canonical debug state value "notstarted"
  const [debugStatus, setDebugStatus] = useState("notstarted");
  // Add ref for tracking the latest debug status
  const debugStatusRef = useRef("notstarted");

  const [executionLine, setExecutionLine] = useState<number | null>(null);
  const [executionFile, setExecutionFile] = useState<string | null>(null);

  const [toolCallLog, setToolCallLog] = useState<
    Array<{
      toolName: string;
      timestamp: number;
    }>
  >([]);

  const [debugLog, setDebugLog] = useState<ReactNode[]>([]);
  const addLog = (msg: ReactNode) => setDebugLog((prev) => [...prev, msg]);

  const watchExpressionsRef = useRef<WatchExpressionsHandle>(null);

  const [selectedTab, setSelectedTab] = useState("status");

  // Add ref to track the last status sequence number processed
  const lastStatusSeqRef = useRef<number | null>(null);

  const getDebugSync = () => {
    return {
      debugStatus,
      breakpoints: mergeBreakpoints(
        queuedBreakpointsRef.current,
        activeBreakpointsRef.current,
      ),
      debugLog,
      toolCallLog: toolCallLog,
      executionFile,
      executionLine,
    };
  };

  const logToolCall = (toolName: string) => {
    setToolCallLog((prev) => [
      ...prev,
      {
        toolName,
        timestamp: Date.now(),
      },
    ]);
  };

  const handleShowDebugSync = () => {
    const syncSnapshot = getDebugSync();
    console.log("DebugSync Snapshot:", syncSnapshot);
  };

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

  const handleToggleDirectory = useCallback(
    async (directory: FileEntry) => {
      console.log(`Toggling directory: ${directory.path}`);
      const success = await fs.toggleDirectoryExpanded(directory.path);

      if (success) {
        console.log(`Successfully toggled directory: ${directory.path}`);
        // Create a fresh copy of the file list to trigger re-render
        const entries = await fs.getEntries("/");
        console.log("Updated entries after toggle:", entries);
        setFiles([...entries]); // Create a new array to ensure state update
      } else {
        console.error(`Failed to toggle directory: ${directory.path}`);
      }
    },
    [fs],
  );

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
      } else if (file.type === "directory") {
        // Toggle directory expansion
        await handleToggleDirectory(file);
      }
    },
    [fs, handleToggleDirectory],
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
        console.log("Selected workspace path:", selected);

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

        console.log("Raw entries received from backend:", entries);

        // Create a simpler mapping approach
        const newFiles: FileEntry[] = [];

        // First, collect all directories
        const directories = entries.filter((entry) => entry.is_dir);

        // Then, collect all files
        const filesOnly = entries.filter((entry) => !entry.is_dir);

        // Add directories first - mark directories as NOT expanded initially
        for (const dir of directories) {
          newFiles.push({
            name: dir.name,
            path: `./${dir.name}`, // Simple path
            type: "directory",
            expanded: false,
            children: [], // Initialize with empty children
          });
        }

        // Add files
        for (const file of filesOnly) {
          newFiles.push({
            name: file.name,
            path: `./${file.name}`, // Simple path
            type: "file",
            content: file.content || "",
          });
        }

        console.log("Processed file entries:", newFiles);

        // Create fresh file system
        const newFs = new InMemoryFileSystem(newFiles, selected);
        setFs(newFs);
        setFiles(newFiles);

        // In the background, expand non-hidden and non-gitignored directories
        newFs.expandDefaultDirectories().then(() => {
          setFiles(newFs.getAllFileEntries());
        });

        // Select first file if available
        const firstFile = newFiles.find((f) => f.type === "file");
        if (firstFile) {
          setSelectedFile(firstFile);
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
            setActiveBreakpoints((currActive) => {
              const updatedBreakpoints = currActive.map((bp) => ({
                ...bp,
                verified: false,
              }));
              setQueuedBreakpoints((prevQueued) => {
                const newQueued = [...prevQueued, ...updatedBreakpoints];
                queuedBreakpointsRef.current = newQueued;
                return newQueued;
              });
              activeBreakpointsRef.current = [];
              return [];
            });
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
    console.log(`handleBreakpointChange called with lineNumber: ${lineNumber}`);
    const currentFilePath = selectedFileRef.current?.path;
    console.log(`Current file path: ${currentFilePath}`);
    if (!currentFilePath) return;

    if (!isDebugSessionActiveRef.current) {
      console.log(`Debug session not active, queueing breakpoint`);
      setQueuedBreakpoints((currentQueued) => {
        console.log(
          `Current queued breakpoints: ${JSON.stringify(currentQueued)}`,
        );
        const exists = currentQueued.some(
          (bp) => bp.line === lineNumber && bp.file === currentFilePath,
        );
        console.log(`Breakpoint exists in queue? ${exists}`);
        let newQueuedBreakpoints: IBreakpoint[];
        if (!exists) {
          console.log(
            `Adding breakpoint to queue: line ${lineNumber}, file ${currentFilePath}`,
          );
          newQueuedBreakpoints = [
            ...currentQueued,
            { line: lineNumber, file: currentFilePath },
          ];
        } else {
          console.log(
            `Removing breakpoint from queue: line ${lineNumber}, file ${currentFilePath}`,
          );
          newQueuedBreakpoints = currentQueued.filter(
            (bp) => !(bp.line === lineNumber && bp.file === currentFilePath),
          );
        }
        // Update the ref with the new breakpoints immediately
        queuedBreakpointsRef.current = newQueuedBreakpoints;
        return newQueuedBreakpoints;
      });
    } else {
      console.log(`Debug session active, setting active breakpoint`);
      setActiveBreakpoints((currentActive) => {
        console.log(
          `Current active breakpoints: ${JSON.stringify(currentActive)}`,
        );
        const exists = currentActive.some(
          (bp) => bp.line === lineNumber && bp.file === currentFilePath,
        );
        console.log(`Breakpoint exists in active? ${exists}`);
        const newBreakpoints = exists
          ? currentActive.filter(
              (bp) => !(bp.line === lineNumber && bp.file === currentFilePath),
            )
          : [...currentActive, { line: lineNumber, file: currentFilePath }];
        console.log(
          `New breakpoints after toggle: ${JSON.stringify(newBreakpoints)}`,
        );

        // Update the ref with the new breakpoints immediately
        activeBreakpointsRef.current = newBreakpoints;

        // Get full file path for the current file
        if (!selectedFileRef.current) return newBreakpoints;
        const fullFilePath = fs.getFullPath(selectedFileRef.current.path);
        console.log(`Full file path for request: ${fullFilePath}`);

        const breakpointsToSend = newBreakpoints.filter(
          (bp) => bp.file === currentFilePath,
        );
        console.log(
          `Sending breakpoints for current file: ${JSON.stringify(breakpointsToSend)}`,
        );

        invoke("set_breakpoints", {
          breakpoints: breakpointsToSend,
          filePath: fullFilePath, // Use full path instead of just the file name
        })
          .then((data) => {
            console.log(`set_breakpoints response: ${JSON.stringify(data)}`);
            const typedData = data as { breakpoints?: IBreakpoint[] };
            if (typedData.breakpoints) {
              // Update active breakpoints with verification status
              const verifiedBps = typedData.breakpoints.map((bp) => ({
                ...bp,
                file: currentFilePath, // Ensure file is set on returned breakpoints
                verified: bp.verified !== false, // Default to true if undefined
              }));
              console.log(
                `Verified breakpoints from server: ${JSON.stringify(verifiedBps)}`,
              );

              setActiveBreakpoints((current) => {
                // Remove current breakpoints for this file
                const othersInOtherFiles = current.filter(
                  (bp) => bp.file !== currentFilePath,
                );
                console.log(
                  `Preserving breakpoints for other files: ${JSON.stringify(othersInOtherFiles)}`,
                );
                // Add the newly verified breakpoints
                const updatedActiveBreakpoints = [
                  ...othersInOtherFiles,
                  ...verifiedBps,
                ];
                // Update the ref with the new breakpoints immediately
                activeBreakpointsRef.current = updatedActiveBreakpoints;
                return updatedActiveBreakpoints;
              });
            }
          })
          .catch((error) => {
            console.error("Failed to update active breakpoints:", error);
          });
        return newBreakpoints;
      });
    }
  };

  const prefillChatInputRef = useRef<((text: string) => void) | null>(null);
  const handleTestSetup = () => {
    // 1. Set the workspace path
    invoke<LoadedFileEntry[]>("read_directory", {
      path: "/Users/mtn/Documents/workspace/wayfind/dap/test_data/python",
    })
      .then(async (entries) => {
        // Process entries to match your FileEntry structure
        const mappedEntries = entries.map(
          (entry) =>
            ({
              name: entry.name,
              path: `./${entry.name}`,
              type: entry.is_dir ? "directory" : "file",
              content: entry.content || "",
              expanded: false,
              children: entry.is_dir ? [] : undefined,
            }) satisfies FileEntry,
        );

        // Create fresh file system
        const newFs = new InMemoryFileSystem(
          mappedEntries,
          "/Users/mtn/Documents/workspace/wayfind/dap/test_data/python",
        );
        setFs(newFs);
        setFiles(mappedEntries);
        const aFile = mappedEntries.find((f) => f.name === "a.py");
        if (aFile) {
          setSelectedFile(aFile);
        }

        // Set debugger to Python
        setDebugEngine("python");

        const testPrompt =
          "set a breakpoint on line 13, then launch the debug session and trace the values next_val takes on as the program runs. you should continue execution and evaluate next_val 10 times. then report to me what values next_val took on.";

        if (prefillChatInputRef.current) {
          prefillChatInputRef.current(testPrompt);
        }
      })
      .catch((error) => {
        console.error("Error loading test directory:", error);
      });

    // For the chat input, we need to address that differently
    // since it's maintained in the ChatInterface component
  };

  const handleDebugSessionStart = async (force: boolean = false) => {
    if (!force && isDebugSessionActive && debugStatus !== "terminated") {
      addLog("Debug session is already launching or active, skipping");
      return;
    }

    // For Rust debugging, check for rust binary path
    if (debugEngine === "rust") {
      if (!rustBinaryPath) {
        addLog(
          <div className="text-red-600">
            Please enter a path to the Rust binary
          </div>,
        );
        return;
      }

      setIsDebugSessionActive(true);
      addLog(`Launching ${debugEngine} debug session...`);
      lastStatusSeqRef.current = null;

      try {
        addLog(`Using binary path: ${rustBinaryPath}`);

        await invoke("launch_debug_session", {
          scriptPath: rustBinaryPath,
          debugEngine,
        });

        addLog(`${debugEngine} debug session launched successfully`);

        // Merge queued and active breakpoints and set them for the new session.
        const allBreakpoints = mergeBreakpoints(
          queuedBreakpointsRef.current,
          activeBreakpointsRef.current,
        );
        setQueuedBreakpoints([]);
        queuedBreakpointsRef.current = [];
        addLog(`Merged breakpoints: ${JSON.stringify(allBreakpoints)}`);

        const uniqueFiles = Array.from(
          new Set(
            allBreakpoints.map((bp) => bp.file).filter((f): f is string => !!f),
          ),
        );
        addLog(`Unique files from breakpoints: ${JSON.stringify(uniqueFiles)}`);

        for (const file of uniqueFiles) {
          const fileBreakpoints = allBreakpoints.filter(
            (bp) => bp.file === file,
          );
          addLog(
            `Processing file: ${file} with breakpoints: ${JSON.stringify(fileBreakpoints)}`,
          );

          const fileEntry = await fs.getFile(file);
          if (!fileEntry) {
            addLog(
              `Could not find file entry for ${file}, skipping breakpoints`,
            );
            console.warn(`File entry not found for ${file}`);
            continue;
          }

          // Get the full filesystem path
          const fullFilePath = fs.getFullPath(fileEntry.path);
          addLog(
            `File entry found for ${file}: ${JSON.stringify(fileEntry)} with full path: ${fullFilePath}`,
          );
          addLog(
            `Setting breakpoints for ${file} (path: ${fullFilePath}): ${JSON.stringify(fileBreakpoints)}`,
          );

          const bpResp = await invoke<{ breakpoints?: IBreakpoint[] }>(
            "set_breakpoints",
            {
              breakpoints: fileBreakpoints,
              filePath: fullFilePath,
            },
          );
          addLog(`Breakpoint response for ${file}: ${JSON.stringify(bpResp)}`);
          if (bpResp.breakpoints) {
            const verifiedBps = bpResp.breakpoints.map((bp) => ({
              ...bp,
              file, // Ensure file is set on returned breakpoints
              verified: bp.verified !== false, // Default to true if undefined
            }));
            addLog(
              `Verified breakpoints for ${file}: ${JSON.stringify(verifiedBps)}`,
            );
            setActiveBreakpoints((current) => {
              const othersInOtherFiles = current.filter(
                (bp) => bp.file !== file,
              );
              const updatedActive = [...othersInOtherFiles, ...verifiedBps];
              activeBreakpointsRef.current = updatedActive;
              return updatedActive;
            });
          }
        }

        // Call configuration_done after setting all breakpoints
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
      } catch (error) {
        addLog(
          `Failed launching debug session: ${
            error instanceof Error ? error.message : error
          }`,
        );
        setIsDebugSessionActive(false);
      }
      return;
    }

    // For Python debugging, we need a selected file
    if (!selectedFile || selectedFile.type !== "file") {
      addLog("No file selected to run for Python debugging");
      return;
    }

    setIsDebugSessionActive(true);
    addLog(`Launching ${debugEngine} debug session...`);
    // Reset the sequence counter when starting a new session
    lastStatusSeqRef.current = null;

    try {
      const scriptPath = fs.getFullPath(selectedFile.path);
      addLog(`Using path: ${scriptPath}`);

      await invoke("launch_debug_session", {
        scriptPath,
        debugEngine,
      });

      addLog(`${debugEngine} debug session launched successfully`);

      // Merge queued and active breakpoints and set them for the new session.
      const allBreakpoints = mergeBreakpoints(
        queuedBreakpointsRef.current,
        activeBreakpointsRef.current,
      );
      setQueuedBreakpoints([]);
      queuedBreakpointsRef.current = [];
      addLog(`Merged breakpoints: ${JSON.stringify(allBreakpoints)}`);
      console.log("Merged breakpoints", allBreakpoints);

      const uniqueFiles = Array.from(
        new Set(
          allBreakpoints.map((bp) => bp.file).filter((f): f is string => !!f),
        ),
      );
      addLog(`Unique files from breakpoints: ${JSON.stringify(uniqueFiles)}`);
      console.log("Unique files", uniqueFiles);

      for (const file of uniqueFiles) {
        const fileBreakpoints = allBreakpoints.filter((bp) => bp.file === file);
        addLog(
          `Processing file: ${file} with breakpoints: ${JSON.stringify(fileBreakpoints)}`,
        );
        console.log(`Processing file: ${file}`, fileBreakpoints);

        const fileEntry = await fs.getFile(file);
        if (!fileEntry) {
          addLog(`Could not find file entry for ${file}, skipping breakpoints`);
          console.warn(`File entry not found for ${file}`);
          continue;
        }

        // Get the full filesystem path
        const fullFilePath = fs.getFullPath(fileEntry.path);
        addLog(
          `File entry found for ${file}: ${JSON.stringify(fileEntry)} with full path: ${fullFilePath}`,
        );
        console.log(`Full file path for ${file}:`, fullFilePath);

        addLog(
          `Setting breakpoints for ${file} (path: ${fullFilePath}): ${JSON.stringify(fileBreakpoints)}`,
        );
        console.log(`Invoking set_breakpoints for ${file}`, {
          breakpoints: fileBreakpoints,
          filePath: fullFilePath,
        });
        const bpResp = await invoke<{ breakpoints?: IBreakpoint[] }>(
          "set_breakpoints",
          {
            breakpoints: fileBreakpoints,
            filePath: fullFilePath, // Use full path instead of just the file name
          },
        );
        addLog(`Breakpoint response for ${file}: ${JSON.stringify(bpResp)}`);
        console.log(`Breakpoint response for ${file}:`, bpResp);
        if (bpResp.breakpoints) {
          const verifiedBps = bpResp.breakpoints.map((bp) => ({
            ...bp,
            file, // Ensure file is set on returned breakpoints
            verified: bp.verified !== false, // Default to true if undefined
          }));
          addLog(
            `Verified breakpoints for ${file}: ${JSON.stringify(verifiedBps)}`,
          );
          console.log(`Verified breakpoints for ${file}:`, verifiedBps);

          setActiveBreakpoints((current) => {
            // Remove current breakpoints for this file
            const othersInOtherFiles = current.filter((bp) => bp.file !== file);
            console.log(
              `Preserving breakpoints for other files:`,
              othersInOtherFiles,
            );
            addLog(
              `Preserving breakpoints for other files for ${file}: ${JSON.stringify(othersInOtherFiles)}`,
            );
            // Add the newly verified breakpoints
            const newActive = [...othersInOtherFiles, ...verifiedBps];
            console.log(
              `New active breakpoints after adding ${file}:`,
              newActive,
            );
            addLog(
              `New active breakpoints for ${file}: ${JSON.stringify(newActive)}`,
            );
            // Update the ref with the new active breakpoints
            activeBreakpointsRef.current = newActive;
            return newActive;
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
      const result = await invoke<EvaluationResult>("evaluate_expression", {
        expression,
      });

      return result;
    } catch (e) {
      addLog(
        <div className="text-red-500">
          Error evaluating <strong>{expression}</strong>:{" "}
          {e instanceof Error ? e.message : String(e)}
        </div>,
      );
      return null;
    }
  };

  const handleContinue = async () => {
    try {
      // Hardcoded thread ID, will need to fix for non-python
      await invoke("continue_debug", { threadId: 1 });
      addLog("Continuing execution");
    } catch (err) {
      addLog(
        <div className="text-red-500">Continue failed: {String(err)}</div>,
      );
      console.error("Continue failed:", err);
    }
  };

  const [showFileOpener, setShowFileOpener] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "p") {
        e.preventDefault();
        setShowFileOpener(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const hasWorkspace = Boolean(fs.getWorkspacePath());
  return (
    <div className="h-screen flex flex-col">
      <div className="p-2">
        <button
          onClick={handleShowDebugSync}
          className="px-4 py-2 bg-blue-500 text-white rounded"
        >
          Show Debug Sync Info
        </button>
        <button
          onClick={handleTestSetup}
          className="px-4 py-2 bg-green-500 text-white rounded"
        >
          Test Setup
        </button>
      </div>
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
                  onToggleDirectory={handleToggleDirectory}
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
                    addLog={addLog}
                    hasWorkspace={hasWorkspace}
                    debugEngine={debugEngine}
                    onDebugEngineChange={setDebugEngine}
                    rustBinaryPath={rustBinaryPath}
                    onRustBinaryPathChange={setRustBinaryPath}
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
                  ).filter((bp) => bp.file === selectedFile?.path)}
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
                getDebugSync={getDebugSync}
                logToolCall={logToolCall}
                onSetBreakpoint={handleBreakpointChange}
                onLaunch={handleDebugSessionStart}
                onContinue={handleContinue}
                onEvaluate={evaluateExpression}
                onLazyExpandDirectory={async (directoryPath: string) => {
                  await fs.toggleDirectoryExpanded(directoryPath);
                  const updated = await fs.getEntries("/");
                  setFiles([...updated]);
                }}
                onPrefillInput={(callback) => {
                  prefillChatInputRef.current = callback;
                }}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>

      {showFileOpener && (
        <FileOpener
          fileSystem={fs}
          onSelectFile={handleFileSelect}
          onClose={() => setShowFileOpener(false)}
        />
      )}
    </div>
  );
}
