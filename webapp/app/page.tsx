"use client"

import { useState } from "react"
import { FileTree } from "@/components/FileTree"
import { MonacoEditorWrapper } from "@/components/MonacoEditor"
import { ChatInterface } from "@/components/ChatInterface"
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

const initialFiles = [
  { name: "main.py", content: 'print("Hello, World!")' },
  { name: "utils.py", content: 'def greet(name):\n    return f"Hello, {name}!"' },
]

export default function Home() {
  const [files, setFiles] = useState(initialFiles)
  const [selectedFile, setSelectedFile] = useState(files[0])

  const handleFileSelect = (file: { name: string; content: string }) => {
    setSelectedFile(file)
  }

  const handleFileChange = (newContent: string) => {
    const updatedFiles = files.map((file) =>
      file.name === selectedFile.name ? { ...file, content: newContent } : file,
    )
    setFiles(updatedFiles)
    setSelectedFile({ ...selectedFile, content: newContent })
  }

  return (
    <div className="h-screen flex flex-col">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel defaultSize={20} minSize={15}>
          <div className="h-full border-r">
            <FileTree files={files} onSelectFile={handleFileSelect} />
          </div>
        </ResizablePanel>
        <ResizablePanel defaultSize={80}>
          <ResizablePanelGroup direction="vertical">
            <ResizablePanel defaultSize={70}>
              <div className="h-full">
                <MonacoEditorWrapper content={selectedFile.content} language="python" onChange={handleFileChange} />
              </div>
            </ResizablePanel>
            <ResizablePanel defaultSize={30}>
              <ChatInterface files={files} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

