import React, { useState, useEffect, useRef } from "react";
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
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Auto-scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }
    }
  }, [selectedIndex]);

  // Focus input on mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

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

  const handleItemClick = (index: number) => {
    const selectedFile = filteredFiles[index];
    onSelectFile(selectedFile.relativePath || selectedFile.name);
    onClose();
  };

  return (
    <div 
      className="bg-white border rounded shadow-lg w-[400px] max-h-[300px] z-50 flex flex-col overflow-hidden"
    >
      <div className="px-3 py-2 border-b text-sm font-medium flex-shrink-0">Insert File</div>
      <input
        ref={inputRef}
        type="text"
        placeholder="Search files..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border-b outline-none text-sm flex-shrink-0"
        onKeyDown={handleKeyDown}
      />
      <div ref={listRef} className="flex-1 overflow-y-auto max-h-48" role="listbox">
        {filteredFiles.map((file, index) => (
          <div
            key={file.relativePath || file.name}
            onClick={() => handleItemClick(index)}
            className={`p-2 cursor-pointer text-sm ${
              index === selectedIndex
                ? "bg-blue-100 text-blue-900"
                : "hover:bg-gray-100"
            }`}
          >
            <div className="font-medium">{file.name}</div>
            {file.relativePath && file.relativePath !== file.name && (
              <div className="text-xs text-gray-500">{file.relativePath}</div>
            )}
          </div>
        ))}
        {filteredFiles.length === 0 && (
          <div className="p-2 text-gray-500 text-sm">
            No files found.
          </div>
        )}
      </div>
    </div>
  );
}