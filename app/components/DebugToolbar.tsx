"use client";

import { useState } from "react";
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
  onDebugSessionStart: () => void;
  debugStatus?: string;
  sessionToken?: string;
  addLog: (msg: string) => void;
  hasWorkspace: boolean;
}

export function DebugToolbar({
  onDebugSessionStart,
  debugStatus,
  sessionToken,
  addLog,
  hasWorkspace,
}: DebugToolbarProps) {
  const [expression, setExpression] = useState("");

  // Use canonical debugStatus: when it's "notstarted" or "terminated" there is no active session.
  const isSessionActive =
    debugStatus !== "notstarted" && debugStatus !== "terminated";
  const canLaunch =
    debugStatus === "notstarted" || debugStatus === "terminated";
  const isPaused = debugStatus === "paused";
  console.log("DEBUG STATUS:", debugStatus);

  async function handleLaunch() {
    try {
      onDebugSessionStart();
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
      const result = await invoke("evaluate_expression", {
        expression,
        threadId: 1,
      });
      addLog(`Evaluation result: ${result}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error evaluating:", errMsg);
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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping over:", errMsg);
    }
  }

  async function handleStepIn() {
    try {
      console.log("Clicked step in");
      // Call the step_in command we just implemented
      await invoke("step_in", {
        threadId: 1,
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
      await invoke("step_out", { threadId: 1 });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stepping out:", errMsg);
    }
  }

  async function handleRestart() {
    try {
      addLog("Restarting debug session...");
      await invoke("terminate_program");
      onDebugSessionStart();
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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Error stopping:", errMsg);
    }
  }

  return (
    <div className="flex flex-col h-full p-4 border-t">
      {/* Debug session status indicator */}
      <div className="mb-2">
        <strong>Status:</strong>{" "}
        {debugStatus === "terminated" ? (
          <span className="text-red-600">Terminated</span>
        ) : (
          <span>{debugStatus}</span>
        )}
      </div>
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
                disabled={!isPaused}
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
