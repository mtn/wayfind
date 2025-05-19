import React, { useState, useEffect } from "react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "cmdk";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  content?: string;
}

interface FileOpenerProps {
  fileSystem: { getAllFileEntries: () => FileEntry[] };
  onSelectFile: (file: FileEntry) => void;
  onClose: () => void;
}

export default function FileOpener({
  fileSystem,
  onSelectFile,
  onClose,
}: FileOpenerProps) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const allFiles = fileSystem.getAllFileEntries();
  const filteredFiles = allFiles.filter(
    (f) =>
      f.type === "file" &&
      (search.length === 0 ||
        f.path.toLowerCase().includes(search.toLowerCase())),
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
          onSelectFile(filteredFiles[selectedIndex]);
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
    // Outer wrapper covers the screen. We do NOT attach onClick={onClose} here,
    // to avoid swallowing keystrokes in the child.
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      {/* This element sits behind the Command panel and closes the dialog on click */}
      <div
        className="absolute inset-0"
        onClick={onClose}
        data-testid="background-overlay"
      />

      {/* The Command panel itself, which stops click propagation so it doesn't close */}
      <Command
        className="relative bg-white rounded-md shadow-lg w-1/3"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="px-3 py-2 border-b text-sm font-bold">Open File</div>
        <CommandInput
          placeholder="Type file name..."
          value={search}
          onValueChange={setSearch}
          autoFocus
          className="w-full px-3 py-2 border-b outline-none"
        />
        <CommandList className="max-h-64 overflow-y-auto">
          {filteredFiles.map((file, index) => (
            <CommandItem
              key={file.path}
              onSelect={() => {
                onSelectFile(file);
                onClose();
              }}
              className={`p-2 cursor-pointer ${
                index === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-gray-100"
              }`}
            >
              {file.path}
            </CommandItem>
          ))}
          {filteredFiles.length === 0 && (
            <CommandEmpty className="p-2 text-gray-500">
              No results found.
            </CommandEmpty>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
