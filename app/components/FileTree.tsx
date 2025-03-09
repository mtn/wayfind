"use client";

import {
  FileIcon,
  FolderIcon,
  FolderOpen,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { FileEntry } from "@/lib/fileSystem";
import { Button } from "./ui/button";

interface FileTreeProps {
  files: FileEntry[];
  selectedFilePath?: string;
  onSelectFile: (file: FileEntry) => void;
  onOpenWorkspace: () => void;
  onToggleDirectory?: (directory: FileEntry) => void;
}

// Helper component for rendering a single file tree item
const FileTreeItem = ({
  entry,
  depth = 0,
  selectedFilePath,
  onSelectFile,
  onToggleDirectory,
}: {
  entry: FileEntry;
  depth: number;
  selectedFilePath?: string;
  onSelectFile: (file: FileEntry) => void;
  onToggleDirectory?: (directory: FileEntry) => void;
}) => {
  const isSelected = selectedFilePath === entry.path;

  const toggleDirectory = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (entry.type === "directory" && onToggleDirectory) {
      onToggleDirectory(entry);
    }
  };

  return (
    <>
      <div
        onClick={() => onSelectFile(entry)}
        className={`
          flex items-center py-1.5 rounded-md cursor-pointer
          ${isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {entry.type === "directory" ? (
          <span onClick={toggleDirectory} className="flex items-center">
            {entry.expanded ? (
              <ChevronDown className="h-4 w-4 mr-1" />
            ) : (
              <ChevronRight className="h-4 w-4 mr-1" />
            )}
            <FolderIcon className="h-4 w-4 mr-2" />
          </span>
        ) : (
          <span className="ml-5 mr-2">
            <FileIcon className="h-4 w-4" />
          </span>
        )}
        <span className="text-sm">{entry.name}</span>
      </div>

      {/* Render children if this is an expanded directory */}
      {entry.type === "directory" && entry.expanded && entry.children && (
        <div className="ml-2">
          {entry.children.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedFilePath={selectedFilePath}
              onSelectFile={onSelectFile}
              onToggleDirectory={onToggleDirectory}
            />
          ))}
        </div>
      )}
    </>
  );
};

export function FileTree({
  files,
  selectedFilePath,
  onSelectFile,
  onOpenWorkspace,
  onToggleDirectory,
}: FileTreeProps) {
  console.log("FileTree rendering with files:", files);

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
      <div className="mt-2 overflow-auto flex-1">
        {files.length > 0 ? (
          <div className="space-y-0.5">
            {files.map((file) => (
              <FileTreeItem
                key={file.path}
                entry={file}
                depth={0}
                selectedFilePath={selectedFilePath}
                onSelectFile={onSelectFile}
                onToggleDirectory={onToggleDirectory}
              />
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground p-2">
            No files found. Open a workspace to get started.
          </div>
        )}
      </div>
    </div>
  );
}
