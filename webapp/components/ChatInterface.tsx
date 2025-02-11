"use client";

import { useState } from "react";
import { useChat } from "ai/react";
import { Button } from "@/components/ui/button";
import { SendIcon } from "lucide-react";

// Optionally keep this helper if you plan on processing message content for display.
function extractUserPrompt(content: string): string {
  const match = content.match(/<userPrompt>([\s\S]*?)<\/userPrompt>/);
  return match ? match[1].trim() : content;
}

interface ChatInterfaceProps {
  files: { name: string; content: string }[];
}

export function ChatInterface({ files }: ChatInterfaceProps) {
  const [input, setInput] = useState("");

  // Get chat-related functionality from the useChat hook.
  const { messages, handleSubmit, handleInputChange, isLoading } = useChat();

  // Convert provided files into an array of Attachment objects.
  // For example, if you have a text file, we set contentType to "text/plain"
  // and create a data URL from the file content.
  const attachments = files.map(({ name, content }) => ({
    name,
    contentType: "text/plain",
    url: `data:text/plain;base64,${btoa(content)}`,
  }));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    // Instead of building a custom XML payload, we simply send the user input as
    // the message text and attach the file data as attachments.
    handleSubmit(e, {
      body: { content: input },
      experimental_attachments: attachments,
    });

    // Clear the input field after submitting.
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
      {/* Messages display area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message, i) => {
          // If you still expect structured content, you can extract it here.
          // Otherwise simply render message.content.
          const displayContent =
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
              {displayContent}
            </div>
          );
        })}
        {isLoading && (
          <div className="flex justify-start p-3">
            <BouncingDots />
          </div>
        )}
      </div>

      {/* Input form */}
      <form
        onSubmit={onSubmit}
        className="p-4 flex gap-2 border-t bg-background"
      >
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // Calling handleInputChange keeps useChat’s internal state in sync.
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
