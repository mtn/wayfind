"use client";

import { useState } from "react";
import { FileIcon, FolderIcon } from "lucide-react";
import { FileEntry } from "@/lib/fileSystem";

interface FileTreeProps {
  files: FileEntry[];
  onSelectFile: (file: FileEntry) => void;
}

export function FileTree({ files, onSelectFile }: FileTreeProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const handleSelectFile = (file: FileEntry) => {
    setSelectedFile(file.path);
    onSelectFile(file);
  };

  return (
    <div className="p-2">
      <div className="text-sm font-medium p-2">Files</div>
      <ul className="space-y-1">
        {files.map((file) => (
          <li
            key={file.path}
            onClick={() => handleSelectFile(file)}
            className={`
              flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer
              ${selectedFile === file.path ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}
            `}
          >
            {file.type === "directory" ? (
              <FolderIcon className="h-4 w-4" />
            ) : (
              <FileIcon className="h-4 w-4" />
            )}
            <span className="text-sm">{file.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
