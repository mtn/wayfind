"use client"

import { useState } from "react"
import { useChat } from "ai/react"
import { Button } from "@/components/ui/button"
import { SendIcon } from "lucide-react"

interface ChatInterfaceProps {
  files: { name: string; content: string }[]
}

export function ChatInterface({ files }: ChatInterfaceProps) {
  const [input, setInput] = useState("")
  const { messages, append } = useChat()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim()) return

    const filesContent = files.map((file) => `${file.name}:\n${file.content}`).join("\n\n")
    append({
      role: "user",
      content: `Files:\n${filesContent}\n\nUser: ${input}`,
    })
    setInput("")
  }

  return (
    <div className="flex flex-col h-full border-t">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message, i) => (
          <div
            key={i}
            className={`
              p-3 rounded-lg text-sm
              ${message.role === "user" ? "bg-primary/10 ml-auto max-w-[80%]" : "bg-muted mr-auto max-w-[80%]"}
            `}
          >
            {message.content}
          </div>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="p-4 flex gap-2 border-t bg-background">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          className="flex-1 px-3 py-2 text-sm rounded-md border bg-background"
        />
        <Button type="submit" size="icon">
          <SendIcon className="h-4 w-4" />
        </Button>
      </form>
    </div>
  )
}

