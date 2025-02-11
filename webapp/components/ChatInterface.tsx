"use client";

import { useState } from "react";
import { useChat } from "ai/react";
import { Button } from "@/components/ui/button";
import { SendIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";

// Helper: extract <userPrompt> from the raw message (purely for display).
function extractUserPrompt(content: string): string {
  const match = content.match(/<userPrompt>([\s\S]*?)<\/userPrompt>/);
  return match ? match[1].trim() : content;
}

interface ChatInterfaceProps {
  files: { name: string; content: string }[];
}

export function ChatInterface({ files }: ChatInterfaceProps) {
  const [input, setInput] = useState("");

  const { messages, handleSubmit, handleInputChange, isLoading } = useChat();

  // Convert the provided files into attachment objects for the API.
  const attachments = files.map(({ name, content }) => ({
    name,
    contentType: "text/plain",
    url: `data:text/plain;base64,${btoa(content)}`,
  }));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    // Here we can send the raw user input and allow the backend to format its markdown response.
    handleSubmit(e, {
      body: { content: input },
      experimental_attachments: attachments,
    });

    // Clear the input field.
    setInput("");
  };

  // A simple loading indicator.
  const BouncingDots = () => (
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
  );

  return (
    <div className="flex flex-col h-full border-t">
      {/* Messages Display */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message, i) => {
          // If the message is from the user, extract the prompt using extractUserPrompt.
          const rawContent =
            message.role === "user"
              ? extractUserPrompt(message.content)
              : message.content;

          return (
            <div
              key={i}
              className={`
                p-3 rounded-lg text-sm
                ${message.role === "user" ? "bg-primary/10 ml-auto max-w-[80%]" : "bg-muted mr-auto max-w-[80%]"}
              `}
            >
              {/* Render the markdown content using ReactMarkdown. */}
              <ReactMarkdown>{rawContent}</ReactMarkdown>
            </div>
          );
        })}
        {isLoading && (
          <div className="flex justify-start p-3">
            <BouncingDots />
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
