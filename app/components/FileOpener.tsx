import React, { useState } from "react";
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
  files: FileEntry[];
  onSelectFile: (file: FileEntry) => void;
  onClose: () => void;
}

export default function FileOpener({
  files,
  onSelectFile,
  onClose,
}: FileOpenerProps) {
  const [search, setSearch] = useState("");

  // Limit to the first 50 files if no search text to keep the list small:
  const filteredFiles =
    search.length > 0
      ? files.filter(
          (f) =>
            f.type === "file" &&
            f.name.toLowerCase().includes(search.toLowerCase()),
        )
      : files.filter((f) => f.type === "file").slice(0, 10);

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
      >
        <div className="px-3 py-2 border-b text-sm font-bold">Open File</div>
        <CommandInput
          placeholder="Type file name..."
          value={search}
          onValueChange={setSearch}
          autoFocus
          className="w-full px-3 py-2 border-b outline-none"
        />
        <CommandList>
          {filteredFiles.map((file) => (
            <CommandItem
              key={file.path}
              onSelect={() => {
                onSelectFile(file);
                onClose();
              }}
              className="p-2 hover:bg-gray-100 cursor-pointer"
            >
              {file.name}
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
