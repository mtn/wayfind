"use client";

import { useEffect, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { IBreakpoint } from "@/app/page";

// Extend the props interface:
interface EditorProps {
  content: string;
  language: string;
  onChange: (value: string) => void;
  breakpoints: IBreakpoint[];
  onBreakpointChange: (lineNumber: number) => void;
  // NEW props for current execution location:
  executionFile?: string | null;
  executionLine?: number | null;
  currentFile: string;
}

export function MonacoEditorWrapper({
  content,
  language,
  onChange,
  breakpoints,
  onBreakpointChange,
  executionFile,
  executionLine,
  currentFile,
}: EditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);

  // Ensure monaco is available (the loader provides the global monaco).
  useEffect(() => {
    // This effect runs each time breakpoints or execution location changes.
    if (!editorRef.current) return;
    const editor = editorRef.current;

    // First, clear all previous decorations.
    decorationsRef.current = editor.deltaDecorations(
      decorationsRef.current,
      [],
    );

    // Map breakpoint decorations.
    const bpDecorations = breakpoints.map((bp) => ({
      range: new monaco.Range(bp.line, 1, bp.line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: getBreakpointClassName(bp),
        glyphMarginHoverMessage: { value: getBreakpointTooltip(bp) },
      },
    }));

    // NEW: Execution decoration – only if the paused file matches the open file.
    const executionDecorations = [];
    // Here we compare executionFile with the current file
    if (
      executionFile &&
      (executionFile === currentFile || executionFile.endsWith(currentFile)) &&
      executionLine
    ) {
      executionDecorations.push({
        range: new monaco.Range(executionLine, 1, executionLine, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: "current-line-arrow",
          className: "current-line-highlight",
          glyphMarginHoverMessage: { value: "Current execution line" },
        },
      });
    }

    const allDecorations = [...bpDecorations, ...executionDecorations];

    decorationsRef.current = editor.deltaDecorations([], allDecorations);
  }, [breakpoints, executionFile, executionLine, currentFile]);

  const getBreakpointClassName = (bp: IBreakpoint) => {
    const classes = ["breakpoint"];
    if (bp.verified) classes.push("verified");
    return classes.join(" ");
  };

  const getBreakpointTooltip = (bp: IBreakpoint) => {
    return bp.verified
      ? "Active breakpoint (click to remove)"
      : "Unverified breakpoint";
  };

  const handleEditorDidMount = (
    editor: Monaco.editor.IStandaloneCodeEditor,
    monaco: typeof Monaco,
  ) => {
    editorRef.current = editor;
    editor.onMouseDown((e) => {
      if (
        e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
      ) {
        onBreakpointChange(e.target.position!.lineNumber);
      }
    });
  };

  return (
    <Editor
      height="100%"
      defaultLanguage={language}
      defaultValue={content}
      value={content}
      theme="vs-dark"
      onChange={(value) => onChange(value || "")}
      onMount={handleEditorDidMount}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        lineNumbers: "on",
        glyphMargin: true,
        scrollBeyondLastLine: false,
        roundedSelection: false,
        padding: { top: 8 },
        automaticLayout: true,
      }}
    />
  );
}
