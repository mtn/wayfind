import React, { useState, useEffect } from "react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "cmdk";
import { FileEntry } from "@/lib/fileSystem";

interface FileInsertDialogProps {
  files: FileEntry[];
  onSelectFile: (filePath: string) => void;
  onClose: () => void;
}

interface FileWithPath extends FileEntry {
  relativePath?: string;
}

export default function FileInsertDialog({
  files,
  onSelectFile,
  onClose,
}: FileInsertDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Get all files recursively
  const getAllFiles = (entries: FileEntry[], basePath = ""): FileWithPath[] => {
    const result: FileWithPath[] = [];
    for (const entry of entries) {
      const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.type === "file") {
        result.push({ ...entry, relativePath: fullPath });
      } else if (entry.type === "directory" && entry.children) {
        result.push(...getAllFiles(entry.children, fullPath));
      }
    }
    return result;
  };

  const allFiles = getAllFiles(files);
  const filteredFiles = allFiles.filter(
    (f) =>
      search.length === 0 ||
      (f.relativePath || f.name).toLowerCase().includes(search.toLowerCase()),
  );

  // Reset selected index when the filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredFiles.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < filteredFiles.length - 1 ? prev + 1 : prev,
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filteredFiles.length > 0 && selectedIndex >= 0) {
          const selectedFile = filteredFiles[selectedIndex];
          onSelectFile(selectedFile.relativePath || selectedFile.name);
          onClose();
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div className="bg-white border rounded shadow-lg w-[400px] max-h-[300px] z-50 flex flex-col overflow-hidden">
      <Command
        className="w-full flex flex-col h-full"
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-3 py-2 border-b text-sm font-medium flex-shrink-0">Insert File</div>
        <CommandInput
          placeholder="Search files..."
          value={search}
          onValueChange={setSearch}
          autoFocus
          className="w-full px-3 py-2 border-b outline-none text-sm flex-shrink-0"
        />
        <CommandList className="flex-1 overflow-y-auto max-h-48" role="listbox">
          {filteredFiles.map((file, index) => (
            <CommandItem
              key={file.relativePath || file.name}
              onSelect={() => {
                onSelectFile(file.relativePath || file.name);
                onClose();
              }}
              className={`p-2 cursor-pointer text-sm ${
                index === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-gray-100"
              }`}
            >
              <div className="font-medium">{file.name}</div>
              {file.relativePath && file.relativePath !== file.name && (
                <div className="text-xs text-gray-500">{file.relativePath}</div>
              )}
            </CommandItem>
          ))}
          {filteredFiles.length === 0 && (
            <CommandEmpty className="p-2 text-gray-500 text-sm">
              No files found.
            </CommandEmpty>
          )}
        </CommandList>
      </Command>
    </div>
  );
}