"use client";

import { useState } from "react";
import { useChat } from "ai/react";
import { openai } from "@ai-sdk/openai";
import { Button } from "@/components/ui/button";
import { SendIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";

// Define your system prompt as a constant.
const systemMessage = {
  role: "system",
  content: `You are a highly skilled debugging assistant.
When you're asked questions about the code, you should always first consider using the debugging tools available to you
to answer it efficiently and accurately. You have access to the following tools:
- setBreakpoint: Sets a breakpoint at a given line number.
- launchDebug: Launches the debugger.
- continueExecution: Continues execution until the next breakpoint.
- evaluateExpression: Evaluates an expression at the current execution point.
Keep in mind that to read the value of a variable, you need to set a breakpoint at least one line _after_ the line that it is
defined on, otherwise, it'll come back as undefined.
For example, if the user asks you how the value of a variable changes as the program runs,
you should use your tools to set breakpoint(s) at lines that let you read the value, launch the program, continue till
it stops, evaluate the variable, and so on until it terminates.
Using the tools is STRICTLY PREFERRED to inspecting the code for answering this type of question.
If the user makes a request like this, YOU MUST USE THE DEBUGGING TOOLS.
NOTE: in the example code next_val is defined on line 12, so to be able to evaluate its value, you should set a breakpoint on line 13.`,
};

interface ChatInterfaceProps {
  files: { name: string; content: string }[];
  onSetBreakpoint: (line: number) => void;
  onLaunch: () => void;
  onContinue: () => void;
  onEvaluate: (expression: string) => Promise<string>;
}

export function ChatInterface({
  files,
  onSetBreakpoint,
  onLaunch,
  onContinue,
  onEvaluate,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");

  // Pass the system prompt as the initialMessages option.
  const { messages, handleSubmit, handleInputChange, isLoading } = useChat({
    model: openai("gpt-3.5-turbo", { apiKey: "FOOBAR" }),
    initialMessages: [systemMessage],
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
      // For unknown tools, return nothing.
    },
  });

  // Create attachments from files.
  const attachments = files.map(({ name, content }) => ({
    name,
    contentType: "text/plain",
    url: `data:text/plain;base64,${btoa(content)}`,
  }));

  // Now on submit, we only send the user message along with any attachments.
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    handleSubmit(e, {
      // Notice we no longer send any session token
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
              ${
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
