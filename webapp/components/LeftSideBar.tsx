"use client";

import React from "react";
import { FileTree } from "./FileTree";
import { DebugToolbar } from "./DebugToolbar";

interface LeftSidebarProps {
  files: { name: string; content: string }[];
  onSelectFile: (file: { name: string; content: string }) => void;
  onDebugSessionStart: () => void;
}

export function LeftSidebar({
  files,
  onSelectFile,
  onDebugSessionStart,
}: LeftSidebarProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Top half: File switcher */}
      <div className="flex-1 border-b overflow-auto">
        <FileTree files={files} onSelectFile={onSelectFile} />
      </div>

      {/* Bottom half: Debug pane */}
      <div className="flex-1 overflow-auto">
        <DebugToolbar onDebugSessionStart={onDebugSessionStart} />
      </div>
    </div>
  );
}
