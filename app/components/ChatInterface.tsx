"use client";

import { useState, useRef, useEffect, useCallback, ReactNode } from "react";
import { useQueuedChat } from "@/lib/useQueuedChat";
import { Button } from "@/components/ui/button";
import { FileEntry, InMemoryFileSystem } from "@/lib/fileSystem";
import ReactMarkdown from "react-markdown";
import { getCaretPosition, setCaretPosition } from "@/lib/utils/caretHelpers";
import { IBreakpoint } from "@/app/page";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import type { EvaluationResult } from "@/components/DebugToolbar";

interface Attachment {
  name: string;
  contentType: string;
  url: string;
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
  onSetBreakpoint: (line: number) => void;
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

// New helper function to parse all /file commands in the text.
function parseFileCommands(text: string, allFiles: FileEntry[]): FileEntry[] {
  const regex = /\/file\s+([^\s]+)/g;
  const matchedFiles: FileEntry[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const candidate = match[1];
    const found = allFiles.find(
      (f) =>
        f.type === "file" && f.name.toLowerCase() === candidate.toLowerCase(),
    );
    if (found) {
      matchedFiles.push(found);
    }
  }
  return matchedFiles;
}

export function ChatInterface({
  files,
  fileSystem,
  onSetBreakpoint,
  onLaunch,
  onContinue,
  onEvaluate,
  getDebugSync,
  logToolCall,
  onLazyExpandDirectory,
  onPrefillInput,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<FileEntry[]>([]);
  const editorRef = useRef<HTMLDivElement>(null);

  const updateSlashSuggestions = useCallback(
    (text: string) => {
      const fileCommandMatch = text.match(/^\/file\s+(\S*)$/);
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
      } else if (text.startsWith("/")) {
        if ("/file".startsWith(text)) {
          setSuggestions(["/file"]);
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

  // Function to highlight the /file command in the contenteditable div.
  const highlightFileCommand = useCallback(() => {
    if (!editorRef.current) return;
    const element = editorRef.current;
    const caretPos = getCaretPosition(element);
    const textContent = element.innerText;
    let html = textContent;
    const regex = /^\/file\s+(\S+)(.*)$/;
    const match = textContent.match(regex);
    if (match) {
      const fileCandidate = match[1];
      const rest = match[2];
      const valid = files.some(
        (f) =>
          f.type === "file" &&
          f.name.toLowerCase() === fileCandidate.trim().toLowerCase(),
      );
      html =
        `<span style="color:${valid ? "green" : "red"}">/file ${fileCandidate}</span>` +
        rest;
    }
    element.innerHTML = html;
    setCaretPosition(element, caretPos);
  }, [files]);

  const {
    messages,
    isLoading: chatIsLoading,
    isThinking,
    send,
    handleInputChange,
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
          // First, set the breakpoint
          const { line } = toolCall.args as { line: number };
          onSetBreakpoint(line);
          actionResult = "Breakpoint set";

          // After handling this specific tool, schedule a follow-up message
          // This is done after returning from this function to avoid interrupting the flow
          setTimeout(() => {
            send({
              role: "user",
              content: "Breakpoint was set successfully.",
              id: crypto.randomUUID(),
            });
          }, 0);
        } else if (toolCall.toolName === "setBreakpointBySearch") {
          // Handle the new text-based breakpoint tool
          interface SearchBreakpointResult {
            foundLine: number;
            matchCount: number;
            searchText: string;
            breakpoints?: any; // The actual breakpoints info from the Rust side
          }

          const { searchText, context, occurrenceIndex, lineOffset, filePath } =
            toolCall.args as {
              searchText: string;
              context?: string;
              occurrenceIndex?: number;
              lineOffset?: number;
              filePath: string;
            };

          console.log("FOO Tool call args", toolCall.args);

          // Resolve the filePath to a full path
          const fullFilePath = fileSystem.getFullPath(filePath);
          console.log(
            `FOO Resolving breakpoint search path: ${filePath} → ${fullFilePath}`,
          );

          // Invoke the Tauri command with resolved path
          const result = await invoke<SearchBreakpointResult>(
            "set_breakpoint_by_search",
            {
              searchText,
              context,
              occurrenceIndex,
              lineOffset,
              filePath: fullFilePath, // Now using the fully resolved path
            },
          );

          console.log("FOO Search breakpoint set successfully");

          actionResult = `Breakpoint set at line ${result.foundLine} (matched "${searchText}")`;

          // Send follow-up message to the chat
          setTimeout(() => {
            send({
              role: "user",
              content: `Breakpoint set on line ${result.foundLine} by searching for "${searchText}".`,
              id: crypto.randomUUID(),
            });
          }, 0);
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
            send({
              role: "user",
              content: `Expression evaluation result: ${expression} = ${result ? result.result : "undefined"}`,
              id: crypto.randomUUID(),
            });
          }, 0);
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
      }
    },
  });

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
    matchedFiles.forEach((fileEntry) => {
      if (fileEntry.content) {
        experimentalAttachments.push({
          name: fileEntry.name,
          contentType: "text/plain",
          url: `data:text/plain;base64,${btoa(fileEntry.content)}`,
        });
      }
    });
    send(input, {
      body: { content: input },
      experimental_attachments: experimentalAttachments,
    });
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
        const { status, file, line } = event.payload;

        // Handle paused status with location information
        if (status === "paused" && file && line) {
          // This is a breakpoint being hit
          const stopMsg = `Breakpoint reached on line ${line} of ${file}.`;

          // Use send to queue the message
          send({
            role: "user",
            content: stopMsg,
            id: crypto.randomUUID(),
          });

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

          // Use send to queue the message
          send({
            role: "user",
            content: statusMsg,
            id: crypto.randomUUID(),
          });

          // Clear the input field
          setInput("");
          if (editorRef.current) {
            editorRef.current.innerText = "";
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
    <div className="flex flex-col h-full border-t relative">
      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Render all messages in their original order */}
        {messages.map((message, messageIndex) => (
          <div
            key={message.id}
            className={`
              p-3 rounded-lg text-sm whitespace-pre-wrap
              ${
                message.role === "user"
                  ? "bg-primary/10 ml-auto max-w-[80%]"
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
                              {JSON.stringify(typedPart.toolInvocation.result)}
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
        ))}

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
                setInput("/file " + newQuery);
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
        className="p-4 flex flex-col gap-2 border-t bg-background"
      >
        <div className="flex gap-2 items-end">
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
          <Button type="submit">
            <span className="text-white">Send</span>{" "}
            <span className="text-gray-500">cmd-enter</span>
          </Button>
        </div>
      </form>
    </div>
  );
}

export default ChatInterface;
