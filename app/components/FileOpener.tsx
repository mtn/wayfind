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

  const filteredFiles = files.filter(
    (f) =>
      f.type === "file" && f.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <Command
        className="bg-white rounded-md shadow-lg w-1/3"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CommandInput
          placeholder="Type to search files..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full px-3 py-2 border-b"
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
