"use client";

import { useState } from "react";
import { useChat } from "ai/react";
import { Button } from "@/components/ui/button";
import { SendIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";

// Import our DAP tool(s) from the consolidated file.
import { setBreakpoint } from "@/tools/dapTools";

interface ChatInterfaceProps {
  // Expect an array of files; each file has a name and content.
  files: { name: string; content: string }[];
  // New callback that should update the breakpoints (just as if the user clicked the gutter).
  onSetBreakpoint: (line: number) => void;
}

// Helper function to extract user prompt if wrapped in a tag.
function extractUserPrompt(content: string): string {
  const match = content.match(/<userPrompt>([\s\S]*?)<\/userPrompt>/);
  return match ? match[1].trim() : content;
}

export function ChatInterface({ files, onSetBreakpoint }: ChatInterfaceProps) {
  const [input, setInput] = useState("");

  // Configure useChat with maxSteps.
  // Note: We do not pass tools here—the API route sends them—but we do define
  // an onToolCall to handle client-side tool calls.
  const { messages, handleSubmit, handleInputChange, isLoading } = useChat({
    maxSteps: 5,
    async onToolCall({ toolCall }) {
      if (toolCall.toolName === "setBreakpoint") {
        // Extract the line number from the tool call arguments.
        const { line } = toolCall.args;
        // Call the onSetBreakpoint callback that was passed from the parent,
        // simulating a gutter click (which toggles the breakpoint in page.tsx).
        onSetBreakpoint(line);
        // Return a dummy tool result so the tool invocation is marked complete.
        return { message: "Breakpoint set." };
      }
      // For any other tools, simply return undefined.
    },
  });

  // Create attachments from files (if needed by your LLM).
  const attachments = files.map(({ name, content }) => ({
    name,
    contentType: "text/plain",
    url: `data:text/plain;base64,${btoa(content)}`,
  }));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    // Submit the user’s prompt (for example, "Set breakpoint on line 5 in a.py")
    handleSubmit(e, {
      body: { content: input },
      experimental_attachments: attachments,
    });
    setInput("");
  };

  return (
    <div className="flex flex-col h-full border-t">
      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`
              p-3 rounded-lg text-sm
              ${message.role === "user" ? "bg-primary/10 ml-auto max-w-[80%]" : "bg-muted mr-auto max-w-[80%]"}
            `}
          >
            {message.parts ? (
              message.parts.map((part, idx) => {
                if (part.type === "text") {
                  return <ReactMarkdown key={idx}>{part.text}</ReactMarkdown>;
                } else if (part.type === "tool-invocation") {
                  // Render a summary of the tool invocation.
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

      {/* Input Form */}
      <form
        onSubmit={onSubmit}
        className="p-4 flex gap-2 border-t bg-background"
      >
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            handleInputChange(e);
          }}
          placeholder="Type your message..."
          className="flex-1 px-3 py-2 text-sm rounded-md border bg-background"
        />
        <Button type="submit" size="icon">
          <SendIcon className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

export default ChatInterface;
