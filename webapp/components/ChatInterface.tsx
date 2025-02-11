"use client";

import { useState } from "react";
import { useChat } from "ai/react";
import { Button } from "@/components/ui/button";
import { SendIcon } from "lucide-react";

// Helper: if the content appears to be structured XML, extract the text inside <userPrompt>
function extractUserPrompt(content: string): string {
  const match = content.match(/<userPrompt>([\s\S]*?)<\/userPrompt>/);
  return match ? match[1].trim() : content;
}

interface ChatInterfaceProps {
  files: { name: string; content: string }[];
}

export function ChatInterface({ files }: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  // Local loading state that’s set to true when submitting
  const [loading, setLoading] = useState(false);

  // Initialize useChat hook with an onFinish callback to clear our loading flag.
  const { messages, append, handleSubmit, handleInputChange } = useChat({
    onFinish: () => setLoading(false),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    // Build a structured XML block with file contents (wrapped in <file> tags)
    // and the actual user prompt wrapped in <userPrompt>
    const filesXML = `<files>${files
      .map(
        (file) =>
          `<file name="${file.name}"><![CDATA[${file.content}]]></file>`,
      )
      .join("")}</files>`;
    const structuredMessage = `${filesXML}\n<userPrompt>${input}</userPrompt>`;

    // Append the structured message to the conversation.
    // (This is what is sent to the API.)
    append({
      role: "user",
      content: structuredMessage,
    });

    // Set our loading state so that a spinner shows in the UI.
    setLoading(true);

    // Submit the conversation (the useChat hook sends the messages to /api/chat).
    handleSubmit(e);

    // Clear the input field.
    setInput("");
  };

  // A simple bouncing-dots component for a visual loading indicator.
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
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message, i) => {
          // For user messages, we display a cleaned version from the structured message.
          const displayContent =
            message.role === "user"
              ? extractUserPrompt(message.content)
              : message.content;
          return (
            <div
              key={i}
              className={`
                p-3 rounded-lg text-sm
                ${
                  message.role === "user"
                    ? "bg-primary/10 ml-auto max-w-[80%]"
                    : "bg-muted mr-auto max-w-[80%]"
                }
              `}
            >
              {displayContent}
            </div>
          );
        })}
        {/* Render the loading indicator when loading is true */}
        {loading && (
          <div className="flex justify-start p-3">
            <BouncingDots />
          </div>
        )}
      </div>
      {/* Input area */}
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
