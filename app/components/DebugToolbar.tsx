"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import {
  Play,
  ArrowRightCircle,
  ArrowDownCircle,
  ArrowUpCircle,
  RotateCcw,
  Square,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DebugToolbarProps {
  onDebugSessionStart: (force: boolean) => void;
  debugStatus?: string;
  addLog: (msg: React.ReactNode) => void;
  hasWorkspace: boolean;
  debugEngine?: string;
  onDebugEngineChange?: (engine: string) => void;
  rustBinaryPath?: string;
  onRustBinaryPathChange?: (path: string) => void;
}

export interface EvaluationResult {
  result: string;
  type?: string;
  variablesReference?: number;
  [key: string]: unknown;
}

export function DebugToolbar({
  onDebugSessionStart,
  debugStatus,
  addLog,
  hasWorkspace,
  debugEngine = "python",
  onDebugEngineChange,
  rustBinaryPath = "",
  onRustBinaryPathChange,
}: DebugToolbarProps) {
  const [expression, setExpression] = useState("");

  // Use canonical debugStatus: when it's "notstarted" or "terminated" there is no active session.
  const isSessionActive =
    debugStatus !== "notstarted" && debugStatus !== "terminated";
  const canLaunch =
    debugStatus === "notstarted" || debugStatus === "terminated";
  const isPaused = debugStatus === "paused";

  async function handleLaunch() {
    try {
      onDebugSessionStart(false);
    } catch (err: unknown) {
      console.error("Error launching session:", err);
    }
  }

  async function handleEvaluate() {
    if (!isSessionActive) {
      console.error("Cannot evaluate: Debug session not started");
      return;
    }
    try {
      const result = await invoke<EvaluationResult>("evaluate_expression", {
        expression,
      });

      // Format the result based on its type
      let displayValue: string | number = result.result;

      // For numeric types, try to parse the result
      if (result.type === "int" || result.type === "float") {
        const numericValue = parseFloat(result.result);
        if (!isNaN(numericValue)) {
          displayValue = numericValue;
        }
      }

      // Use JSX for formatted output
      addLog(
        <div>
          <strong>{expression}</strong> = {displayValue}
        </div>,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error evaluating:", errMsg);

      // Format error message with JSX
      addLog(
        <div className="text-red-500">
          Error evaluating <strong>{expression}</strong>: {errMsg}
        </div>,
      );
    } finally {
      setExpression("");
    }
  }

  async function handleContinue() {
    if (!isSessionActive) {
      console.error("Cannot continue: Debug session not started");
      return;
    }
    try {
      await invoke("continue_debug", { threadId: 1 });
      addLog("Continuing execution");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error continuing execution:", errMsg);
      addLog(`Failed to continue: ${errMsg}`);
    }
  }

  async function handleStepOver() {
    try {
      await invoke("step_over", { threadId: 1 });
      addLog("Stepping over next line");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping over:", errMsg);
      addLog(`Failed to step over: ${errMsg}`);
    }
  }

  async function handleStepIn() {
    try {
      console.log("Clicked step in");
      // Call the step_in command we just implemented
      await invoke("step_in", {
        granularity: "statement", // Default granularity
      });
      addLog("Stepping into next function");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping into:", errMsg);
      addLog(`Failed to step in: ${errMsg}`);
    }
  }

  async function handleStepOut() {
    try {
      // Call the step_out command we just implemented
      await invoke("step_out", {
        granularity: "statement", // Default granularity
      });
      addLog("Stepping out of current function");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping out:", errMsg);
      addLog(`Failed to step out: ${errMsg}`);
    }
  }

  async function handleRestart() {
    try {
      addLog("Restarting debug session...");
      await invoke("terminate_program");
      onDebugSessionStart(true);
      addLog("Debug session restarted successfully.");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error restarting debug session:", errMsg);
      addLog("Error restarting debug session: " + errMsg);
    }
  }

  async function handleTerminate() {
    try {
      await invoke("terminate_program");
      addLog("Terminating debug session");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error terminating session:", errMsg);
      addLog(`Failed to terminate: ${errMsg}`);
    }
  }

  return (
    <div className="flex flex-col h-full p-4 border-t">
      {/* Debug session status indicator */}
      <div className="mb-2 flex justify-between items-center">
        <div>
          <strong>Status:</strong>{" "}
          {debugStatus === "terminated" ? (
            <span className="text-red-600">Terminated</span>
          ) : (
            <span>{debugStatus}</span>
          )}
        </div>

        {/* Debug engine selector */}
        <div className="flex items-center gap-2">
          <span className="text-sm">Debug Engine:</span>
          <select
            value={debugEngine}
            onChange={(e) => onDebugEngineChange?.(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
            disabled={isSessionActive}
          >
            <option value="python">Python</option>
            <option value="rust">Rust</option>
          </select>
        </div>
      </div>

      {/* Rust binary path input */}
      {debugEngine === "rust" && !isSessionActive && (
        <div className="mb-4">
          <label htmlFor="rustBinaryPath" className="block text-sm mb-1">
            Rust Binary Path:
          </label>
          <input
            id="rustBinaryPath"
            type="text"
            value={rustBinaryPath}
            onChange={(e) => onRustBinaryPathChange?.(e.target.value)}
            placeholder="Enter path to compiled Rust binary"
            className="w-full border rounded px-2 py-1 text-sm"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-4 mb-4">
        {!isSessionActive && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-block">
                  <Button
                    onClick={handleLaunch}
                    disabled={!hasWorkspace || !canLaunch}
                  >
                    <Play />
                    Launch Debug Session
                  </Button>
                </span>
              </TooltipTrigger>
              {!hasWorkspace && (
                <TooltipContent>
                  <p>Open a workspace to launch a debug session</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
        {isSessionActive && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Enter expression"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleEvaluate();
                  }
                }}
                className="border rounded px-2 py-1"
                disabled={!isPaused}
              />
              <Button onClick={handleEvaluate} disabled={!isPaused}>
                Evaluate
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={handleContinue}
                disabled={!isPaused}
                title="Continue"
              >
                <Play className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleStepOver}
                disabled={!isPaused}
                title="Step Over"
              >
                <ArrowRightCircle className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleStepIn}
                disabled={!isPaused}
                title="Step Into"
              >
                <ArrowDownCircle className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleStepOut}
                disabled={!isPaused}
                title="Step Out"
              >
                <ArrowUpCircle className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleRestart}
                disabled={!isPaused}
                title="Restart"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleTerminate}
                disabled={!isSessionActive} // Enable whenever a session is active
                title="Stop"
              >
                <Square className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default DebugToolbar;
