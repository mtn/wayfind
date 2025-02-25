"use client";

import { FileIcon, FolderIcon, FolderOpen } from "lucide-react";
import { FileEntry } from "@/lib/fileSystem";
import { Button } from "./ui/button";

interface FileTreeProps {
  files: FileEntry[];
  selectedFilePath?: string;
  onSelectFile: (file: FileEntry) => void;
  onOpenWorkspace: () => void;
}

export function FileTree({
  files,
  selectedFilePath,
  onSelectFile,
  onOpenWorkspace,
}: FileTreeProps) {
  return (
    <div className="p-2 flex flex-col h-full">
      <div className="flex items-center justify-between p-2">
        <div className="text-sm font-medium">Files</div>
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenWorkspace}
          className="flex items-center gap-2"
        >
          <FolderOpen className="h-4 w-4" />
          Open Workspace
        </Button>
      </div>
      <ul className="space-y-1 mt-2">
        {files.map((file) => (
          <li
            key={file.path}
            onClick={() => onSelectFile(file)}
            className={`
              flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer
              ${selectedFilePath === file.path ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}
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
