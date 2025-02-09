"use client"

import { useState } from "react"
import { FileIcon } from "lucide-react"

interface File {
  name: string
  content: string
}

interface FileTreeProps {
  files: File[]
  onSelectFile: (file: File) => void
}

export function FileTree({ files, onSelectFile }: FileTreeProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  const handleSelectFile = (file: File) => {
    setSelectedFile(file.name)
    onSelectFile(file)
  }

  return (
    <div className="p-2">
      <div className="text-sm font-medium p-2">Files</div>
      <ul className="space-y-1">
        {files.map((file) => (
          <li
            key={file.name}
            onClick={() => handleSelectFile(file)}
            className={`
              flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer
              ${selectedFile === file.name ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}
            `}
          >
            <FileIcon className="h-4 w-4" />
            <span className="text-sm">{file.name}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

