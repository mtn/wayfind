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

// TODO try and make these types non-optional
export interface IBreakpoint {
  line: number;
  verified?: boolean;
  // Path relative to the workspace root
  file?: string;
}

const initialFiles: FileEntry[] = [];

export default function Home() {
  const [fs, setFs] = useState(() => new InMemoryFileSystem(initialFiles));
  const [files, setFiles] = useState<FileEntry[]>(initialFiles);
  const [selectedFile, setSelectedFile] = useState<FileEntry | undefined>(
    undefined,
  );

  const [jumpRequest, setJumpRequest] = useState<{
    file: string;
    line: number;
  } | null>(null);

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

  // Ref to store chat interface callback for manual evaluations
  const chatManualEvalRef = useRef<
    ((expression: string, result: EvaluationResult) => void) | null
  >(null);

  // Handle manual evaluation from DebugToolbar
  const handleManualEvaluation = useCallback(
    (expression: string, result: EvaluationResult) => {
      if (chatManualEvalRef.current) {
        chatManualEvalRef.current(expression, result);
      }
    },
    [],
  );
  // Add ref for tracking the latest debug status
  const debugStatusRef = useRef("notstarted");

  const [executionLine, setExecutionLine] = useState<number | null>(null);
  const [executionFile, setExecutionFile] = useState<string | null>(null);

  const toolCallLogRef = useRef<
    Array<{
      toolName: string;
      timestamp: number;
    }>
  >([]);

  const [debugLog, setDebugLog] = useState<ReactNode[]>([]);
  const addLog = (msg: ReactNode) => setDebugLog((prev) => [...prev, msg]);

  const watchExpressionsRef = useRef<WatchExpressionsHandle>(null);

  // Auto-mode state - controls whether unsolicited events are forwarded to LLM
  const [autoModeOn, setAutoModeOn] = useState(true);
  const autoModeRef = useRef(autoModeOn);
  useEffect(() => {
    autoModeRef.current = autoModeOn;
  }, [autoModeOn]);

  const [selectedTab, setSelectedTab] = useState("status");

  // Add ref to track the last status sequence number processed
  const lastStatusSeqRef = useRef<number | null>(null);

  const getDebugSync = () => {
    return {
      debugStatus: debugStatusRef.current,
      breakpoints: mergeBreakpoints(
        queuedBreakpointsRef.current,
        activeBreakpointsRef.current,
      ),
      debugLog,
      toolCallLog: toolCallLogRef.current,
      executionFile,
      executionLine,
      debugLanguage: debugEngine,
    };
  };

  const logToolCall = (toolName: string) => {
    toolCallLogRef.current = [
      ...toolCallLogRef.current,
      {
        toolName,
        timestamp: Date.now(),
      },
    ];
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

  const handleOpenWorkspace = async (providedPath?: string) => {
    try {
      // If a path is provided, use it directly; otherwise open a directory picker
      const selected =
        providedPath ||
        (await open({
          directory: true,
          multiple: false,
        }));

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

        // Preload directories in the background without expanding them
        void (async () => {
          // fire‑and‑forget; we don't await, so the click handler returns immediately
          await newFs.preloadAllDirectories();
          console.info("Background directory preload finished");
        })();

        // Select first file if available
        const firstFile = newFiles.find((f) => f.type === "file");
        if (firstFile) {
          setSelectedFile(firstFile);
        }

        return true; // Indicate success
      }
      return false; // Indicate no path was selected
    } catch (error) {
      console.error("Error opening workspace:", error);
      return false;
    }
  };

  const isDebugSessionActiveRef = useRef(isDebugSessionActive);
  useEffect(() => {
    isDebugSessionActiveRef.current = isDebugSessionActive;
  }, [isDebugSessionActive]);

  // Listen for debug status events using canonical DAP events.
  // Add a ref to track whether we've already set up the debug status listener
  const hasStatusListenerRef = useRef(false);

  // Listen for debug status events using canonical DAP events.
  useEffect(() => {
    // If we've already set up the listener, don't set it up again
    if (hasStatusListenerRef.current) {
      return;
    }

    // Mark that we've set up the listener
    hasStatusListenerRef.current = true;

    let unlistenStatus: () => void;
    (async () => {
      unlistenStatus = await listen("debug-status", (event) => {
        console.log("Debug status event received:", event);
        const payload = event.payload as {
          status: string;
          seq: number;
          threadId?: number;
          file?: string;
          line?: number;
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

            // Extract file and line from the payload directly
            const file = payload.file as string | undefined;
            const line = payload.line as number | undefined;

            if (file && line) {
              console.log(
                `Received debug location in status: file=${file}, line=${line}`,
              );

              // Convert to relative path if possible
              let relativePath = file;
              const workspacePath = fsRef.current.getWorkspacePath();
              if (workspacePath && file.startsWith(workspacePath)) {
                relativePath = `./${file.substring(workspacePath.length).replace(/^[\/\\]+/, "")}`;
              }

              // Update execution position with relative path
              setExecutionFile(relativePath);
              setExecutionLine(line);

              // Extract just the filename from the path (still using original file path)
              const fileName = file.split("/").pop();

              // If the stopped file is different from the current file, try to open it
              if (fileName && fileName !== selectedFile?.name) {
                const fileEntry = files.find((f) => f.name === fileName);
                if (fileEntry) {
                  handleFileSelect(fileEntry);
                } else {
                  console.warn(`File ${fileName} not found in the workspace`);
                }
              }
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
        // Reset the ref when unmounting so it can be set up again if needed
        hasStatusListenerRef.current = false;
      }
    };
  }, [files, handleFileSelect, selectedFile?.name]);

  const fsRef = useRef(fs);

  // Keep the ref in sync with the state
  useEffect(() => {
    fsRef.current = fs;
  }, [fs]);

  const handleBreakpointChange = (
    lineNumber: number,
    fileEntry?: FileEntry,
  ) => {
    console.log(`handleBreakpointChange called with lineNumber: ${lineNumber}`);
    // Use provided fileEntry if available, otherwise use the currently selected file
    const currentFilePath = fileEntry?.path || selectedFileRef.current?.path;
    console.log(`Using file path: ${currentFilePath}`);
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
        // Use fileEntry if provided, otherwise use selectedFileRef.current
        const fileToUse = fileEntry || selectedFileRef.current;
        if (!fileToUse) return newBreakpoints;

        const fullFilePath = fsRef.current.getFullPath(fileToUse.path);
        console.log(`Full file path for request: ${fullFilePath}`);

        const breakpointsToSend = newBreakpoints.filter(
          (bp) => bp.file === currentFilePath,
        );
        console.log(
          `Sending breakpoints for current file: ${JSON.stringify(breakpointsToSend)}`,
        );

        invoke("set_breakpoint", {
          breakpoints: breakpointsToSend,
          filePath: fullFilePath, // Use full path instead of just the file name
        })
          .then((data) => {
            console.log(`set_breakpoint response: ${JSON.stringify(data)}`);
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

    // If we were given an explicit fileEntry (i.e. this came from a tool
    // call rather than a gutter click) → queue a jump.
    if (fileEntry) {
      // Ensure the file is fully selected before creating the jump request
      handleFileSelect(fileEntry).then(() => {
        setJumpRequest({ file: currentFilePath, line: lineNumber });
      });
    }
  };

  const prefillChatInputRef = useRef<((text: string) => void) | null>(null);
  const handleTestSetup = async () => {
    try {
      // First set the debug engine to Python
      setDebugEngine("python");

      const pythonTestPath =
        "/Users/mtn/Documents/workspace/wayfind/dap/test_data/python";

      // Use handleOpenWorkspace with the Python test path
      const success = await handleOpenWorkspace(pythonTestPath);

      if (success) {
        // Look for a.py file to select it
        const aFile = files.find((f) => f.name === "a.py");
        if (aFile) {
          setSelectedFile(aFile);
        }

        // Set up the test prompt
        const testPrompt =
          "/file a.py trace how next_val changes as the program runs, then give me a summary";

        if (prefillChatInputRef.current) {
          prefillChatInputRef.current(testPrompt);
        }
      }
    } catch (error) {
      console.error("Error setting up test:", error);
    }
  };

  const handleTestSetup2 = async () => {
    // Set the debugger to Rust mode
    setDebugEngine("rust");

    try {
      const targetPath = "/Users/mtn/Documents/workspace/scratch/zed";

      // Use the refactored handleOpenWorkspace function with a provided path
      const success = await handleOpenWorkspace(targetPath);

      if (success) {
        // After workspace loads, prepare the test prompt
        // TODO If the breakpoint is set on a non-code line the breakpoint gets swallowed.
        // Check how other debuggers handle it (e.g. workspace.rs a few lines above the target)
        const testPrompt = `Set a breakpoint on line 3386 of crates/workspace/src/workspace.rs

          I'm working on a PR in the zed editor, and this function is responsible for navigating to the next active pane in a certain direction.
          I'm trying to add circular navigation support, so if the user is in the rightmost pane and activates the pane to the right, it should wrap around and jump to the leftmost pane.
          It's not working quite correctly though.

          I'm testing with three panes open.
          | Assistant | Editor 1 | Editor 2 |

          If I start in editor 2 and move right, it should jump to assistant. However, it jumps to editor 1.

          The function we're debugging is defined on lines 3372 to 3477.

          I'm going to perform this test, which should trigger the breakpoint. Please help me figure out why it's jumping to the wrong pane.
          `;
        // "/file crates/workspace/src/workspace.rs set a breakpoint on line 3397 of workspace.rs, then launch the debug session. After the program stops at the breakpoint, say 'foobar'";

        if (prefillChatInputRef.current) {
          prefillChatInputRef.current(testPrompt);
        }
      }
    } catch (error) {
      console.error("Error opening workspace for Test Setup 2:", error);
    }
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
            "set_breakpoint",
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
        console.log(`Invoking set_breakpoint for ${file}`, {
          breakpoints: fileBreakpoints,
          filePath: fullFilePath,
        });
        const bpResp = await invoke<{ breakpoints?: IBreakpoint[] }>(
          "set_breakpoint",
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

  // Global Shift+Tab shortcut to toggle auto-mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        setAutoModeOn((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const hasWorkspace = Boolean(fs.getWorkspacePath());
  return (
    <div className="h-screen flex flex-col">
      <div className="p-2 flex gap-2">
        <button
          onClick={handleTestSetup}
          className="px-4 py-2 bg-green-500 text-white rounded"
        >
          Test Setup 1
        </button>
        <button
          onClick={handleTestSetup2}
          className="px-4 py-2 bg-blue-500 text-white rounded"
        >
          Test Setup 2
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
                    onManualEvaluation={handleManualEvaluation}
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
                    <div className="h-full border rounded-md bg-background">
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
                  onBreakpointChange={(lineNumber) =>
                    handleBreakpointChange(lineNumber)
                  }
                  executionFile={executionFile}
                  executionLine={executionLine}
                  currentFile={selectedFile?.name}
                  jumpLine={jumpRequest ? jumpRequest.line : null}
                  onJumpHandled={() => setJumpRequest(null)}
                />
              </div>
            </ResizablePanel>
            <ResizablePanel defaultSize={40}>
              <ChatInterface
                files={files}
                fileSystem={fs}
                getDebugSync={getDebugSync}
                logToolCall={logToolCall}
                onSetBreakpoint={handleBreakpointChange}
                onFileSelect={handleFileSelect}
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
                onRegisterManualEvalHandler={(handler) => {
                  chatManualEvalRef.current = handler;
                }}
                autoModeOn={autoModeOn}
                onAutoModeChange={setAutoModeOn}
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
