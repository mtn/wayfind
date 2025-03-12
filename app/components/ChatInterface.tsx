"use client";

import { useState } from "react";
import { useChat } from "ai/react";
import { Button } from "@/components/ui/button";
import { FileEntry } from "@/lib/fileSystem";
import { SendIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import ChatInput from "@/components/ChatInput"; // ensure this file exists and is exported as default

import type { EvaluationResult } from "@/components/DebugToolbar";

interface Attachment {
  name: string;
  contentType: string;
  url: string;
}

interface ChatInterfaceProps {
  // An array of files that provide context.
  files: FileEntry[];
  // Callback to update breakpoints.
  onSetBreakpoint: (line: number) => void;
  // Callback to launch a debug session.
  onLaunch: () => void;
  // Callback to continue execution.
  onContinue: () => void;
  // Callback to evaluate an expression.
  onEvaluate: (expression: string) => Promise<EvaluationResult | null>;
  // Optional callback to lazily expand a directory.
  onLazyExpandDirectory?: (directoryPath: string) => Promise<void>;
}

// Helper function to extract a wrapped user prompt.
function extractUserPrompt(content: string): string {
  const match = content.match(/<userPrompt>([\s\S]*?)<\/userPrompt>/);
  return match ? match[1].trim() : content;
}

// Helper function to locate a directory in the file tree.
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

export function ChatInterface({
  files,
  onSetBreakpoint,
  onLaunch,
  onContinue,
  onEvaluate,
  onLazyExpandDirectory,
}: ChatInterfaceProps) {
  // editorText holds the plain text from our Lexical-based ChatInput.
  const [editorText, setEditorText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<FileEntry[]>([]);

  // Update suggestions based on input.
  const updateSlashSuggestions = (text: string) => {
    if (text.startsWith("/file ")) {
      const query = text.slice(6).trim();
      if (query.endsWith("/")) {
        const dirPath = query.slice(0, -1);
        if (onLazyExpandDirectory) {
          onLazyExpandDirectory(dirPath).then(() => {
            const matches = getFileSuggestions(query, files);
            setFileSuggestions(matches);
          });
        } else {
          const matches = getFileSuggestions(query, files);
          setFileSuggestions(matches);
        }
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
  };

  // Parse a file command from text.
  const parseFileCommand = (text: string): FileEntry | null => {
    if (!text.startsWith("/file ")) return null;
    const candidate = text.slice(6).trim();
    return (
      files.find(
        (f) =>
          f.type === "file" && f.name.toLowerCase() === candidate.toLowerCase(),
      ) || null
    );
  };

  // Configure useChat.
  const { messages, handleSubmit, isLoading } = useChat({
    api: "http://localhost:3001/api/chat",
    maxSteps: 5,
    async onToolCall({ toolCall }) {
      if (toolCall.toolName === "setBreakpoint") {
        const { line } = toolCall.args as { line: number };
        onSetBreakpoint(line);
        return { message: "Breakpoint set." };
      } else if (toolCall.toolName === "launchDebug") {
        onLaunch();
        return { message: "Debug session launched." };
      } else if (toolCall.toolName === "continueExecution") {
        onContinue();
        return { message: "Continued execution." };
      } else if (toolCall.toolName === "evaluateExpression") {
        const { expression } = toolCall.args as { expression: string };
        const result = await onEvaluate(expression);
        return { message: `Evaluation result: ${result}` };
      }
    },
  });

  // Build attachments from files (for extra context) – left as stub.
  const attachments: Attachment[] = [];
  files.forEach((f) => {
    if (f.type === "directory") {
      // TODO: handle directories.
    } else {
      // Optional: add file attachment based on file content.
      // attachments.push({ ... });
    }
  });

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editorText.trim()) return;
    const experimentalAttachments = [...attachments];
    if (editorText.startsWith("/file ")) {
      const fileEntry = parseFileCommand(editorText);
      if (fileEntry && fileEntry.content) {
        experimentalAttachments.push({
          name: fileEntry.name,
          contentType: "text/plain",
          url: `data:text/plain;base64,${btoa(fileEntry.content)}`,
        });
      }
    }
    handleSubmit(e, {
      body: { content: editorText },
      experimental_attachments: experimentalAttachments,
    });
    setEditorText("");
  };

  return (
    <div className="flex flex-col h-full border-t relative">
      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`
              p-3 rounded-lg text-sm ${
                message.role === "user"
                  ? "bg-primary/10 ml-auto max-w-[80%]"
                  : "bg-muted mr-auto max-w-[80%]"
              }
            `}
          >
            {message.parts ? (
              message.parts.map((part, idx) => {
                if (part.type === "text") {
                  return <ReactMarkdown key={idx}>{part.text}</ReactMarkdown>;
                } else if (part.type === "tool-invocation") {
                  return (
                    <div
                      key={idx}
                      className="text-xs text-gray-600 border rounded p-1"
                    >
                      <strong>Tool Call:</strong> {part.toolInvocation.toolName}{" "}
                      with args {JSON.stringify(part.toolInvocation.args)}
                      <br />
                      <em>Status: {part.toolInvocation.state}</em>
                      {part.toolInvocation.state === "result" && (
                        <>
                          <br />
                          <strong>Result:</strong>{" "}
                          {JSON.stringify(part.toolInvocation.result)}
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
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start p-3">
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
                setEditorText(s + " ");
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
                const currentQuery = editorText.slice(6).trim();
                const parts = currentQuery.split("/");
                parts[parts.length - 1] = file.name;
                const newQuery = parts.join("/") + " ";
                setEditorText("/file " + newQuery);
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
        onSubmit={handleChatSubmit}
        className="p-4 flex flex-col gap-2 border-t bg-background"
      >
        <ChatInput
          onChange={(text) => {
            setEditorText(text);
            updateSlashSuggestions(text);
          }}
        />
        <Button type="submit" size="icon">
          <SendIcon className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

export default ChatInterface;
