"use client";

import { useState, useRef, useEffect, useCallback, ReactNode } from "react";
import { Message, UseChatHelpers } from "ai/react";
import { useQueuedChat } from "@/lib/useQueuedChat";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info, Plus } from "lucide-react";
import { FileEntry, InMemoryFileSystem } from "@/lib/fileSystem";
import ReactMarkdown from "react-markdown";
import {
  getCaretPosition,
  setCaretPosition,
  insertAtCaret,
} from "@/lib/utils/caretHelpers";
import { IBreakpoint } from "@/app/page";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import FileInsertDialog from "./FileInsertDialog";

import type { EvaluationResult } from "@/components/DebugToolbar";

interface Attachment {
  name: string;
  contentType: string;
  url: string;
}

// Extended Message interface to track tool call results
interface ExtendedMessage extends Message {
  isToolResult?: boolean;
}

interface DebugSyncData {
  debugStatus: string;
  breakpoints: IBreakpoint[];
  debugLog: ReactNode[];
  toolCallLog: Array<{
    toolName: string;
    timestamp: number;
  }>;
  executionFile: string | null;
  executionLine: number | null;
}
interface ChatInterfaceProps {
  // An array of files that provide context.
  files: FileEntry[];
  // File system instance for path resolution
  fileSystem: InMemoryFileSystem;
  // Callback to update breakpoints (as if the user clicked the gutter).
  onSetBreakpoint: (line: number, file?: FileEntry) => void;
  // Callback to select a file in the editor
  onFileSelect: (file: FileEntry) => Promise<void>;
  // Callback to launch a debug session.
  onLaunch: () => void;
  // Callback to continue execution.
  onContinue: () => void;
  // Callback to evaluate an expression. Should return a promise resolving to a string.
  onEvaluate: (expression: string) => Promise<EvaluationResult | null>;
  // Get the debug sync data to feed to the model.
  getDebugSync: () => DebugSyncData;
  // Callback to add a tool call to the tool call log
  logToolCall: (toolName: string) => void;
  // Optional callback to lazily expand a directory based on its relative path.
  onLazyExpandDirectory?: (directoryPath: string) => Promise<void>;
  // Optional callback to prefill the chat input.
  onPrefillInput?: (prefillCallback: (text: string) => void) => void;
  // Optional callback to register manual evaluation handler
  onRegisterManualEvalHandler?: (
    handler: (expression: string, result: EvaluationResult) => void,
  ) => void;
  // Auto-mode state and setter
  autoModeOn: boolean;
  onAutoModeChange: (value: boolean) => void;
}

// Helper function to extract a wrapped user prompt.
function extractUserPrompt(content: string): string {
  const match = content.match(/<userPrompt>([\s\S]*?)<\/userPrompt>/);
  return match ? match[1].trim() : content;
}

// Helper function to locate a directory in the file tree based on an array of path parts.
function findDirectory(
  pathParts: string[],
  fileNodes: FileEntry[],
): FileEntry | undefined {
  let currentNodes = fileNodes;
  let result: FileEntry | undefined;
  for (const part of pathParts) {
    result = currentNodes.find(
      (f) =>
        f.name.toLowerCase() === part.toLowerCase() && f.type === "directory",
    );
    if (!result) return undefined;
    currentNodes = result.children || [];
  }
  return result;
}

// Helper function to get file suggestions based on a query.
function getFileSuggestions(query: string, fileTree: FileEntry[]): FileEntry[] {
  const parts = query.split("/");
  if (parts.length === 1) {
    return fileTree.filter((f) =>
      f.name.toLowerCase().startsWith(query.toLowerCase()),
    );
  }
  const dirPath = parts.slice(0, parts.length - 1);
  const partial = parts[parts.length - 1];
  const dir = findDirectory(dirPath, fileTree);
  if (!dir || !dir.children) return [];
  return dir.children.filter((child) =>
    child.name.toLowerCase().startsWith(partial.toLowerCase()),
  );
}

function validateFilePath(
  filePath: string,
  files: FileEntry[],
): FileEntry | undefined {
  // Check if this is a path with directories
  if (filePath.includes("/")) {
    // Get all parts of the path
    const parts = filePath.split("/");
    const fileName = parts.pop() || "";

    // Try to find the directory
    const currentDir = findDirectory(parts, files);

    // If we found the directory, look for the file in its children
    if (currentDir && currentDir.children) {
      return currentDir.children.find(
        (f) =>
          f.type === "file" && f.name.toLowerCase() === fileName.toLowerCase(),
      );
    }
  } else {
    // Simple top-level file lookup
    return files.find(
      (f) =>
        f.type === "file" &&
        f.name.toLowerCase() === filePath.trim().toLowerCase(),
    );
  }

  // If no match found, return undefined
  return undefined;
}

function parseFileCommands(text: string, allFiles: FileEntry[]): FileEntry[] {
  const regex = /@file\s+([^\s]+)/g;
  const matchedFiles: FileEntry[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const candidate = match[1];
    const fileEntry = validateFilePath(candidate, allFiles);
    if (fileEntry) {
      matchedFiles.push(fileEntry);
    }
  }

  return matchedFiles;
}

export function ChatInterface({
  files,
  fileSystem,
  onSetBreakpoint,
  onFileSelect,
  onLaunch,
  onContinue,
  onEvaluate,
  getDebugSync,
  logToolCall,
  onLazyExpandDirectory,
  onPrefillInput,
  onRegisterManualEvalHandler,
  autoModeOn,
  onAutoModeChange,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<FileEntry[]>([]);
  const [showInsertDialog, setShowInsertDialog] = useState(false);
  const [savedCaretPosition, setSavedCaretPosition] = useState<number>(0);
  const editorRef = useRef<HTMLDivElement>(null);

  const updateSlashSuggestions = useCallback(
    (text: string) => {
      const fileCommandMatch = text.match(/^@file\s+(\S*)$/);
      if (fileCommandMatch) {
        const query = fileCommandMatch[1];
        if (query.endsWith("/") && onLazyExpandDirectory) {
          const dirPath = query.slice(0, -1);
          onLazyExpandDirectory(dirPath).then(() => {
            const matches = getFileSuggestions(query, files);
            setFileSuggestions(matches);
          });
        } else {
          const matches = getFileSuggestions(query, files);
          setFileSuggestions(matches);
        }
        setSuggestions([]);
      } else if (text.startsWith("@")) {
        if ("@file".startsWith(text)) {
          setSuggestions(["@file"]);
        } else {
          setSuggestions([]);
        }
        setFileSuggestions([]);
      } else {
        setSuggestions([]);
        setFileSuggestions([]);
      }
    },
    [files, onLazyExpandDirectory],
  );

  const highlightFileCommand = useCallback(() => {
    if (!editorRef.current) return;
    const element = editorRef.current;
    const caretPos = getCaretPosition(element);
    const textContent = element.innerText;
    let html = textContent;
    const regex = /@file\s+(\S+)/g;

    // Replace all @file commands in the text
    html = textContent.replace(regex, (match, fileCandidate) => {
      const valid = Boolean(validateFilePath(fileCandidate, files));
      return `<span style="color:${valid ? "green" : "red"}">@file ${fileCandidate}</span>`;
    });

    element.innerHTML = html;
    setCaretPosition(element, caretPos);
  }, [files]);

  const {
    messages,
    isLoading: chatIsLoading,
    isThinking,
    send,
    stop,
    handleInputChange,
    queueLength,
    isFlushing,
    setMessages,
  } = useQueuedChat({
    api: "http://localhost:3001/api/chat",
    maxSteps: 1,
    experimental_prepareRequestBody({ messages, requestBody }) {
      const debugState = getDebugSync();
      return {
        ...requestBody,
        messages,
        debugState,
      };
    },
    onResponse(response) {
      console.log("Response from server:", response);

      // Define the type for custom responses with events
      interface CustomResponse {
        events?: {
          type?: string;
          data?: {
            type?: string;
          };
        }[];
      }

      // Check the raw response for reasoning events
      const customResponse = response as CustomResponse;
      if (customResponse?.events) {
        const events = customResponse.events;
        const hasReasoning = events.some(
          (event) =>
            event.type === "reasoning" ||
            (event.data && event.data.type === "reasoning"),
        );
        if (hasReasoning) {
          console.log(
            "Reasoning detected in server response:",
            events.filter(
              (event) =>
                event.type === "reasoning" ||
                (event.data && event.data.type === "reasoning"),
            ),
          );
        }
      }
    },
    async onToolCall({ toolCall }) {
      setToolCallsInFlight((c) => c + 1);
      console.log("Tool call starting:", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
      });

      let actionResult;
      logToolCall(toolCall.toolName);

      try {
        // Handle different tool calls
        if (toolCall.toolName === "setBreakpointByLine") {
          // Extract both line AND filePath from the args
          const { line, filePath } = toolCall.args as {
            line: number;
            filePath: string;
          };

          // Use the file system to find the file by its path
          const fileEntry = await fileSystem.getFile(filePath);

          if (!fileEntry) {
            throw new Error(`File not found: ${filePath}`);
          }

          // Select the file first for visual feedback
          await onFileSelect(fileEntry);

          // Pass both line and fileEntry explicitly
          onSetBreakpoint(line, fileEntry);
          actionResult = "Breakpoint set";

          // After handling this specific tool, schedule a follow-up message
          // This is done after returning from this function to avoid interrupting the flow
          setTimeout(() => {
            if (autoModeRef.current) {
              originate({
                role: "user",
                content: "Breakpoint was set successfully.",
                id: crypto.randomUUID(),
                isToolResult: true,
              } as ExtendedMessage);
            } else {
              appendLocal({
                role: "user",
                content: "Breakpoint was set successfully.",
                id: crypto.randomUUID(),
                isToolResult: true,
              } as ExtendedMessage);
            }
          }, 0);
        } else if (toolCall.toolName === "setBreakpointBySearch") {
          // Define the result interface
          interface ResolveBreakpointResult {
            foundLine: number;
            matchCount: number;
            searchText: string;
            filePath: string;
          }

          const { searchText, context, occurrenceIndex, lineOffset, filePath } =
            toolCall.args as {
              searchText: string;
              context?: string;
              occurrenceIndex?: number;
              lineOffset?: number;
              filePath: string;
            };

          // Resolve the file path
          const fullFilePath = fileSystem.getFullPath(filePath);
          console.log(
            `Resolving breakpoint search path: ${filePath} → ${fullFilePath}`,
          );

          try {
            // First, resolve the line number through text search
            const result = await invoke<ResolveBreakpointResult>(
              "resolve_breakpoint_by_search",
              {
                searchText,
                context,
                occurrenceIndex,
                lineOffset,
                filePath: fullFilePath,
              },
            );

            // Use the file system to find the file by its path
            const fileEntry = await fileSystem.getFile(filePath);

            if (!fileEntry) {
              throw new Error(`File not found: ${filePath}`);
            }

            // Select the file first for visual feedback
            await onFileSelect(fileEntry);

            // Now set the breakpoint using the existing mechanism, passing the file explicitly
            onSetBreakpoint(result.foundLine, fileEntry);

            actionResult = `Breakpoint set at line ${result.foundLine} (matched "${searchText}")`;

            // Send follow-up message
            setTimeout(() => {
              if (autoModeRef.current) {
                originate({
                  role: "user",
                  content: `Breakpoint set on line ${result.foundLine} by searching for "${searchText}" in ${fileEntry.name}.`,
                  id: crypto.randomUUID(),
                  isToolResult: true,
                } as ExtendedMessage);
              } else {
                appendLocal({
                  role: "user",
                  content: `Breakpoint set on line ${result.foundLine} by searching for "${searchText}" in ${fileEntry.name}.`,
                  id: crypto.randomUUID(),
                  isToolResult: true,
                } as ExtendedMessage);
              }
            }, 0);
          } catch (error) {
            console.error("Error setting breakpoint by search:", error);
            const errMsg =
              error instanceof Error ? error.message : String(error);

            setTimeout(() => {
              const msgContent = `Failed to set breakpoint by search: ${errMsg}`;
              if (autoModeRef.current) {
                originate({
                  role: "user",
                  content: msgContent,
                  id: crypto.randomUUID(),
                  isToolResult: true,
                } as ExtendedMessage);
              } else {
                appendLocal({
                  role: "user",
                  content: msgContent,
                  id: crypto.randomUUID(),
                  isToolResult: true,
                } as ExtendedMessage);
              }
            }, 0);

            throw error;
          }
        } else if (toolCall.toolName === "launchDebug") {
          onLaunch();
          actionResult = "Debug session launched";
        } else if (toolCall.toolName === "continueExecution") {
          onContinue();
          actionResult = "Continued execution";
        } else if (toolCall.toolName === "evaluateExpression") {
          const { expression } = toolCall.args as { expression: string };
          const result = await onEvaluate(expression);
          actionResult = result ? `Evaluated: ${result.result}` : "No result";

          setTimeout(() => {
            if (autoModeRef.current) {
              originate({
                role: "user",
                content: `Expression evaluation result: ${expression} = ${result ? result.result : "undefined"}`,
                id: crypto.randomUUID(),
                isToolResult: true,
              } as ExtendedMessage);
            } else {
              appendLocal({
                role: "user",
                content: `Expression evaluation result: ${expression} = ${result ? result.result : "undefined"}`,
                id: crypto.randomUUID(),
                isToolResult: true,
              } as ExtendedMessage);
            }
          }, 0);
        } else if (toolCall.toolName === "readFileContent") {
          const { filePath, startLine, endLine } = toolCall.args as {
            filePath: string;
            startLine?: number;
            endLine?: number;
          };

          const fullFilePath = fileSystem.getFullPath(filePath);
          console.log(`Resolving file path: ${filePath} → ${fullFilePath}`);

          try {
            // Pass the RESOLVED path to the Rust backend
            const result = await invoke<string>("read_file_content", {
              filePath: fullFilePath,
              startLine,
              endLine,
            });

            actionResult = `Read ${result.length} characters from ${filePath}`;

            // Send follow-up message with file content
            setTimeout(() => {
              if (autoModeRef.current) {
                originate({
                  role: "user",
                  content: `File content for ${filePath}:\n\`\`\`\n${result}\n\`\`\``,
                  id: crypto.randomUUID(),
                  isToolResult: true,
                } as ExtendedMessage);
              } else {
                appendLocal({
                  role: "user",
                  content: `File content for ${filePath}:\n\`\`\`\n${result}\n\`\`\``,
                  id: crypto.randomUUID(),
                  isToolResult: true,
                } as ExtendedMessage);
              }
            }, 0);
          } catch (error) {
            console.error("Error reading file:", error);
            throw error;
          }
        }

        console.log("Tool call completed successfully:", {
          toolName: toolCall.toolName,
          actionResult,
        });

        return {
          message: actionResult,
        };
      } catch (error) {
        console.error("Error in tool call execution:", {
          toolName: toolCall.toolName,
          error,
        });
        throw error;
      } finally {
        // after queueing any follow-up message
        setToolCallsInFlight((c) => c - 1);
      }
    },
  });

  // active tool-calls
  const [toolCallsInFlight, setToolCallsInFlight] = useState(0);

  // Track whether assistant owns the current conversational context
  const activeTurn = useRef(false);

  // Auto-mode ref for consistency with other refs
  const autoModeRef = useRef(autoModeOn);
  useEffect(() => {
    autoModeRef.current = autoModeOn;
  }, [autoModeOn]);

  // Listen for manual debug actions to turn off auto-mode
  useEffect(() => {
    function off() {
      onAutoModeChange(false);
    }
    window.addEventListener("manual-debug-action", off);
    return () => window.removeEventListener("manual-debug-action", off);
  }, [onAutoModeChange]);

  // Expose the single flag to the rest of the app
  const assistantBusy =
    chatIsLoading || // streaming / writing
    isThinking || // "analysis" parts only
    queueLength > 0 || // queued user follow-ups
    isFlushing || // currently popping from queue
    toolCallsInFlight > 0; // waiting on tool result

  // Make it available to parents via custom event
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("assistant-busy", { detail: assistantBusy }),
    );
  }, [assistantBusy]);

  // Clear activeTurn when assistantBusy transitions from true to false
  const prevBusy = useRef(false);
  useEffect(() => {
    console.log(
      `assistantBusy transition: ${prevBusy.current} -> ${assistantBusy}, activeTurn: ${activeTurn.current}`,
    );
    if (prevBusy.current && !assistantBusy) {
      console.log("Clearing activeTurn");
      activeTurn.current = false;
    }
    prevBusy.current = assistantBusy;
  }, [assistantBusy]);

  // Function to originate messages that expect a reply
  const originate = useCallback(
    (
      content: string | Message | ExtendedMessage,
      opts?: Parameters<UseChatHelpers["append"]>[1],
      enableAutoMode: boolean = true,
    ) => {
      console.log("Setting activeTurn to true");
      if (enableAutoMode) {
        onAutoModeChange(true); // arm auto-mode only if requested
      }
      activeTurn.current = true;
      send(content, opts);
    },
    [send, onAutoModeChange],
  );

  // Function to append message locally without sending to LLM
  const appendLocal = useCallback(
    (content: string | Message | ExtendedMessage) => {
      const msg: Message =
        typeof content === "string"
          ? { id: crypto.randomUUID(), role: "user", content }
          : content;

      setMessages((prevMessages) => [...prevMessages, msg]);
    },
    [setMessages],
  );

  // Handle manual evaluation results with gating logic
  const handleManualEvaluation = useCallback(
    (expression: string, result: EvaluationResult) => {
      const evalMsg = `Expression evaluation result: ${expression} = ${result.result}`;

      // Gate unsolicited events - only send to LLM if auto-mode is enabled
      if (autoModeRef.current) {
        console.log("Manual evaluation - sending to LLM");
        // Use send to queue the message (not originate, as this is a response)
        send({
          role: "user",
          content: evalMsg,
          id: crypto.randomUUID(),
          isToolResult: true,
        } as ExtendedMessage);
      } else {
        console.log("Manual evaluation gated - appending locally only");
        // Append locally so assistant can see it if invoked later
        appendLocal({
          role: "user",
          content: `${evalMsg}`,
          id: crypto.randomUUID(),
          isToolResult: true,
        } as ExtendedMessage);
      }
    },
    [autoModeRef, send, appendLocal],
  );

  // Register the manual evaluation handler
  useEffect(() => {
    if (onRegisterManualEvalHandler) {
      onRegisterManualEvalHandler(handleManualEvaluation);
    }
  }, [onRegisterManualEvalHandler, handleManualEvaluation]);

  // Create attachments from files (for additional context).
  const attachments: Attachment[] = [];
  files.forEach((f) => {
    if (f.type === "directory") {
      // TODO
    } else {
      // TODO need to improve / reenable functionality for getting code into LLM
      // attachments.push({
      //   name: f.name,
      //   contentType: "text/plain",
      //   url: f.content ? `data:text/plain;base64,${btoa(f.content)}` : "",
      // });
    }
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const experimentalAttachments = [...attachments];
    const matchedFiles = parseFileCommands(input, files);

    // Helper function for Unicode-safe base64 encoding
    function encodeUnicodeSafeBase64(str: string): string {
      // Convert the string to UTF-8 encoded array buffer
      const encoder = new TextEncoder();
      const utf8Bytes = encoder.encode(str);

      // Convert the array buffer to a string that btoa can handle
      return btoa(
        Array.from(utf8Bytes)
          .map((byte) => String.fromCharCode(byte))
          .join(""),
      );
    }

    matchedFiles.forEach((fileEntry) => {
      if (fileEntry.content) {
        experimentalAttachments.push({
          name: fileEntry.name,
          contentType: "text/plain",
          url: `data:text/plain;base64,${encodeUnicodeSafeBase64(fileEntry.content)}`,
        });
      }
    });
    originate(
      input,
      {
        body: { content: input },
        experimental_attachments: experimentalAttachments,
      },
      false,
    ); // Don't auto-enable auto-mode, let user control it manually
    setInput("");
    if (editorRef.current) {
      editorRef.current.innerText = "";
    }
  };

  const submitMessage = () => {
    // Create a fake event to pass to onSubmit.
    const fakeEvent = {
      preventDefault: () => {},
    } as React.FormEvent<HTMLFormElement>;
    onSubmit(fakeEvent);
  };

  const handleInsert = (filePath: string) => {
    console.log("handleInsert called with:", filePath);
    if (editorRef.current) {
      console.log("Editor ref exists, inserting text at cursor");

      // First, focus the editor and restore cursor position
      editorRef.current.focus();
      setCaretPosition(editorRef.current, savedCaretPosition);

      // Insert at the current cursor position
      insertAtCaret(editorRef.current, `@file ${filePath} `);

      // Update the input state to match the editor content
      const newText = editorRef.current.innerText;
      setInput(newText);
      handleInputChange({
        target: { value: newText },
      } as React.ChangeEvent<HTMLInputElement>);

      // Update syntax highlighting
      updateSlashSuggestions(newText);
      requestAnimationFrame(() => highlightFileCommand());

      console.log("Text updated to:", newText);
    } else {
      console.log("Editor ref is null");
    }
    setShowInsertDialog(false);
  };

  const handleOpenDialog = () => {
    if (editorRef.current) {
      // Save the current cursor position before opening dialog
      setSavedCaretPosition(getCaretPosition(editorRef.current));
    }
    setShowInsertDialog(true);
  };

  // Register the prefill callback
  useEffect(() => {
    if (onPrefillInput) {
      onPrefillInput((text: string) => {
        // Set the input state that will be submitted
        setInput(text);

        // Update the contentEditable div
        if (editorRef.current) {
          editorRef.current.innerText = text;
        }

        // Also update the AI SDK's input state by simulating an input change event
        handleInputChange({
          target: { value: text },
        } as React.ChangeEvent<HTMLInputElement>);

        // Also run any highlighting logic
        updateSlashSuggestions(text);
        requestAnimationFrame(() => highlightFileCommand());
      });
    }
  }, [
    onPrefillInput,
    handleInputChange,
    highlightFileCommand,
    updateSlashSuggestions,
  ]);

  // Track previously notified debug status to avoid duplicate messages
  const lastStatusRef = useRef<string | null>(null);

  // Listen for all debug status changes and notify the LLM
  // Track if we've already set up the debug status listener
  const hasStatusListenerRef = useRef(false);

  // Listen for all debug status changes and notify the LLM
  useEffect(() => {
    // Only set up listener once
    if (hasStatusListenerRef.current) return;
    hasStatusListenerRef.current = true;

    let unlisten: () => void;
    (async () => {
      unlisten = await listen<{
        status: string;
        seq?: number;
        file?: string;
        line?: number;
      }>("debug-status", (event) => {
        console.log("Debug status event received");
        const { status, file, line } = event.payload;

        // Handle paused status with location information
        if (status === "paused" && file && line) {
          const stopMsg = `Breakpoint reached on line ${line} of ${file}.`;

          // Gate unsolicited events - only send to LLM if auto-mode is enabled
          if (autoModeRef.current) {
            console.log("Processing debug status event - sending to LLM");
            // Use send to queue the message (not originate, as this is a response)
            send({
              role: "user",
              content: stopMsg,
              id: crypto.randomUUID(),
              isToolResult: true,
            } as ExtendedMessage);
          } else {
            console.log("Debug status event gated - appending locally only");
            // Append locally so assistant can see it if invoked later
            appendLocal({
              role: "user",
              content: `${stopMsg}`,
              id: crypto.randomUUID(),
              isToolResult: true,
            } as ExtendedMessage);
            return;
          }

          // Clear the input field
          setInput("");
          if (editorRef.current) {
            editorRef.current.innerText = "";
          }

          // Update the lastStatusRef
          lastStatusRef.current = status;
          return;
        }

        // Handle other status changes
        // Only notify if status has changed since last notification
        // AND it's not the "initializing" status
        if (status !== lastStatusRef.current && status !== "initializing") {
          lastStatusRef.current = status;

          // Prepare message for LLM
          const statusMsg = `Debug session status changed to: ${status}`;

          // Gate unsolicited events - only send to LLM if auto-mode is enabled
          if (autoModeRef.current) {
            console.log("Processing debug status change - sending to LLM");
            // Use send to queue the message (not originate, as this is a response)
            send({
              role: "user",
              content: statusMsg,
              id: crypto.randomUUID(),
              isToolResult: true,
            } as ExtendedMessage);

            // Clear the input field
            setInput("");
            if (editorRef.current) {
              editorRef.current.innerText = "";
            }
          } else {
            console.log("Debug status change gated - appending locally only");
            // Append locally so assistant can see it if invoked later
            appendLocal({
              role: "user",
              content: `${statusMsg}`,
              id: crypto.randomUUID(),
              isToolResult: true,
            } as ExtendedMessage);
          }
        } else {
          // Still update the lastStatusRef even if we don't send a message
          lastStatusRef.current = status;
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debug location handling has been moved to the debug-status listener
  // No separate debug-location listener is needed anymore

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full border-t relative">
        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Render all messages in their original order */}
          {messages.map((message, messageIndex) => {
            const extendedMessage = message as ExtendedMessage;
            const isToolResult = extendedMessage.isToolResult;

            return (
              <div
                key={message.id}
                className={`
                p-3 rounded-lg text-sm whitespace-pre-wrap
                ${
                  message.role === "user"
                    ? isToolResult
                      ? "bg-gray-100 mx-auto max-w-[80%] text-left text-gray-600 border-dashed border border-gray-300"
                      : "bg-primary/10 ml-auto max-w-[80%]"
                    : "bg-muted mr-auto max-w-[80%]"
                }
              `}
              >
                {message.role === "user" ? (
                  <ReactMarkdown>
                    {extractUserPrompt(message.content)}
                  </ReactMarkdown>
                ) : (
                  <>
                    {/* Render assistant message content */}
                    {message.parts ? (
                      message.parts.map((part, idx) => {
                        type ToolInvocation = {
                          toolName: string;
                          args: Record<string, unknown>;
                          state: string;
                          result?: unknown;
                        };

                        type MessagePart =
                          | { type: "text"; text: string }
                          | {
                              type: "tool-invocation";
                              toolInvocation: ToolInvocation;
                            };

                        const typedPart = part as MessagePart;

                        if (typedPart.type === "text") {
                          return (
                            <ReactMarkdown key={idx}>
                              {typedPart.text}
                            </ReactMarkdown>
                          );
                        } else if (typedPart.type === "tool-invocation") {
                          return (
                            <div
                              key={idx}
                              className="text-xs text-gray-600 border rounded p-1 mb-2"
                            >
                              <strong>Tool Call:</strong>{" "}
                              {typedPart.toolInvocation.toolName} with args{" "}
                              {JSON.stringify(typedPart.toolInvocation.args)}
                              <br />
                              <em>Status: {typedPart.toolInvocation.state}</em>
                              {typedPart.toolInvocation.state === "result" && (
                                <>
                                  <br />
                                  <strong>Result:</strong>{" "}
                                  {JSON.stringify(
                                    typedPart.toolInvocation.result,
                                  )}
                                </>
                              )}
                            </div>
                          );
                        }
                        return null;
                      })
                    ) : (
                      <ReactMarkdown>
                        {extractUserPrompt(message.content)}
                      </ReactMarkdown>
                    )}

                    {/* Show thinking indicator only for the last assistant message during loading */}
                    {messageIndex === messages.length - 1 &&
                      chatIsLoading &&
                      isThinking && (
                        <div className="flex items-center gap-2 mt-2">
                          <div className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                          <span className="text-sm text-blue-700 font-medium">
                            Thinking...
                          </span>
                        </div>
                      )}
                  </>
                )}
              </div>
            );
          })}

          {/* If we're loading but there's no assistant message yet, show a standalone indicator */}
          {chatIsLoading &&
            messages.length > 0 &&
            messages[messages.length - 1].role === "user" && (
              <div className="p-3 rounded-lg text-sm whitespace-pre-wrap bg-muted mr-auto max-w-[80%]">
                {isThinking ? (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                    <span className="text-sm text-blue-700 font-medium">
                      Thinking...
                    </span>
                  </div>
                ) : (
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" />
                    <div
                      className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
                      style={{ animationDelay: "0.2s" }}
                    />
                    <div
                      className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
                      style={{ animationDelay: "0.4s" }}
                    />
                  </div>
                )}
              </div>
            )}
        </div>

        {/* Suggestions Dropdown for Commands */}
        {suggestions.length > 0 && (
          <div
            className="absolute bg-white border rounded shadow py-1 px-2 z-10 w-auto"
            style={{ bottom: "60px", left: "16px", right: "16px" }}
          >
            {suggestions.map((s, idx) => (
              <div
                key={idx}
                className="cursor-pointer hover:bg-gray-200 p-0.5"
                onClick={() => {
                  setInput(s + " ");
                  setSuggestions([]);
                }}
              >
                <div className="font-medium">{s}</div>
                <div className="text-xs text-gray-500">
                  Insert file and/or directory
                </div>
              </div>
            ))}
          </div>
        )}

        {/* File Suggestions Dropdown */}
        {fileSuggestions.length > 0 && (
          <div
            className="absolute bg-white border rounded shadow py-1 px-2 z-10 max-h-64 overflow-y-auto w-auto"
            style={{ bottom: "60px", left: "16px", right: "16px" }}
          >
            {fileSuggestions.map((file, idx) => (
              <div
                key={idx}
                className="cursor-pointer hover:bg-gray-200 p-0.5"
                onClick={() => {
                  const currentQuery = input.slice(6).trim();
                  const parts = currentQuery.split("/");
                  parts[parts.length - 1] = file.name;
                  const newQuery = parts.join("/") + " ";
                  setInput("@file " + newQuery);
                  setFileSuggestions([]);
                }}
              >
                <div className="font-medium">{file.name}</div>
                <div className="text-xs text-gray-500">
                  Insert file and/or directory
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Input Form */}
        <form
          onSubmit={onSubmit}
          className="p-2 flex flex-col gap-2 border-t bg-background relative"
        >
          <div className="flex gap-2 items-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenDialog}
              className="px-2 py-2 h-[38px]"
            >
              <Plus className="w-4 h-4" />
            </Button>
            <div
              ref={editorRef}
              contentEditable
              onInput={(e) => {
                const newText = e.currentTarget.textContent || "";
                setInput(newText);
                handleInputChange({
                  target: { value: newText },
                } as React.ChangeEvent<HTMLInputElement>);
                updateSlashSuggestions(newText);
                requestAnimationFrame(() => highlightFileCommand());
              }}
              onPaste={(e) => {
                e.preventDefault();
                const text = e.clipboardData.getData("text/plain");
                if (editorRef.current) {
                  const selection = window.getSelection();
                  if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    range.deleteContents();
                    range.insertNode(document.createTextNode(text));
                    selection.collapseToEnd();
                  } else {
                    editorRef.current.textContent += text;
                  }
                }
                requestAnimationFrame(() => {
                  highlightFileCommand();
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.metaKey) {
                  e.preventDefault();
                  if (editorRef.current) {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                      const range = selection.getRangeAt(0);
                      const br = document.createElement("br");
                      range.deleteContents();
                      range.insertNode(br);
                      range.setStartAfter(br);
                      range.setEndAfter(br);
                      selection.removeAllRanges();
                      selection.addRange(range);
                    }
                  }
                } else if (e.metaKey && e.key === "Enter") {
                  e.preventDefault();
                  submitMessage();
                }
              }}
              className="flex-1 px-3 py-2 text-sm rounded-md border bg-background min-h-[30px] whitespace-pre-wrap"
            />
            {assistantBusy ? (
              <Button type="button" onClick={stop} variant="destructive">
                <span className="text-white">Stop</span>
              </Button>
            ) : (
              <Button type="submit">
                <span className="text-white">Send</span>{" "}
                <span className="text-gray-500">cmd-enter</span>
              </Button>
            )}
          </div>

          {/* File Insert Dialog */}
          {showInsertDialog && (
            <div className="absolute bottom-full left-2 mb-1 z-50">
              <FileInsertDialog
                files={files}
                onSelectFile={handleInsert}
                onClose={() => setShowInsertDialog(false)}
              />
            </div>
          )}
        </form>

        {/* Auto-mode status */}
        <div className="px-2 pb-2 text-xs text-gray-500 text-right flex items-center justify-end gap-1">
          <span>
            auto mode is {autoModeOn ? "on" : "off"} (shift-tab to toggle)
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="w-3 h-3 cursor-help text-gray-400 hover:text-gray-600" />
            </TooltipTrigger>
            <TooltipContent>
              <p>
                In auto-mode, the LLM will continue to respond and act in a loop
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default ChatInterface;
