import React, { useState } from "react";
import { Button } from "@/components/ui/button";

interface SettingsDialogProps {
  debugpyPath: string;
  lldbPath: string;
  onSave: (paths: { debugpyPath: string; lldbPath: string }) => void;
  onClose: () => void;
}

export default function SettingsDialog({
  debugpyPath,
  lldbPath,
  onSave,
  onClose,
}: SettingsDialogProps) {
  const [debugpy, setDebugpy] = useState(debugpyPath);
  const [lldb, setLldb] = useState(lldbPath);

  const handleSave = () => {
    onSave({ debugpyPath: debugpy, lldbPath: lldb });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        className="bg-white rounded-md shadow-lg w-96 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Binary Paths</h2>
        <div className="mb-3">
          <label htmlFor="debugpyPath" className="block text-sm mb-1">
            Python Interpreter for debugpy
          </label>
          <input
            id="debugpyPath"
            type="text"
            value={debugpy}
            onChange={(e) => setDebugpy(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </div>
        <div className="mb-4">
          <label htmlFor="lldbPath" className="block text-sm mb-1">
            lldb-dap Path
          </label>
          <input
            id="lldbPath"
            type="text"
            value={lldb}
            onChange={(e) => setLldb(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </div>
    </div>
  );
}
