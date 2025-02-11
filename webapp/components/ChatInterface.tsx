"use client";

import { useState } from "react";
import { useChat } from "ai/react";
import { Button } from "@/components/ui/button";
import { SendIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";

interface ChatInterfaceProps {
  // An array of files that provide context.
  files: { name: string; content: string }[];
  // Callback to update breakpoints (as if the user clicked the gutter).
  onSetBreakpoint: (line: number) => void;
  // Callback to launch a debug session.
  onLaunch: () => void;
  // Callback to continue execution.
  onContinue: () => void;
  // Callback to evaluate an expression. Should return a promise resolving to a string.
  onEvaluate: (expression: string) => Promise<string>;
}

// Helper function to extract a wrapped user prompt.
function extractUserPrompt(content: string): string {
  const match = content.match(/<userPrompt>([\s\S]*?)<\/userPrompt>/);
  return match ? match[1].trim() : content;
}

export function ChatInterface({
  files,
  onSetBreakpoint,
  onLaunch,
  onContinue,
  onEvaluate,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");

  // Configure useChat with maxSteps. Do not pass a tools field (they come from the API).
  // Instead, intercept tool calls via onToolCall.
  const { messages, handleSubmit, handleInputChange, isLoading } = useChat({
    maxSteps: 5,
    async onToolCall({ toolCall }) {
      if (toolCall.toolName === "setBreakpoint") {
        const { line } = toolCall.args;
        onSetBreakpoint(line);
        return { message: "Breakpoint set." };
      } else if (toolCall.toolName === "launchDebug") {
        onLaunch();
        return { message: "Debug session launched." };
      } else if (toolCall.toolName === "continueExecution") {
        onContinue();
        return { message: "Continued execution." };
      } else if (toolCall.toolName === "evaluateExpression") {
        const { expression } = toolCall.args;
        const result = await onEvaluate(expression);
        return { message: `Evaluation result: ${result}` };
      }
      // For unknown tools, return nothing.
    },
  });

  // Create attachments from files (for additional context).
  const attachments = files.map(({ name, content }) => ({
    name,
    contentType: "text/plain",
    url: `data:text/plain;base64,${btoa(content)}`,
  }));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    // Send the prompt (e.g.: "Launch debug" or "Set a breakpoint on line 5 in a.py")
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
