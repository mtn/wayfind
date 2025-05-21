"use client";

import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
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
  currentFile?: string | null;
  jumpLine?: number | null;
  onJumpHandled?: () => void;
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
  jumpLine,
  onJumpHandled,
}: EditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);
  const contentRef = useRef<string>(content);

  useEffect(() => {
    if (jumpLine != null && editorRef.current && jumpLine > 0) {
      editorRef.current.revealLineInCenter(jumpLine);
      onJumpHandled?.();
    }
  }, [jumpLine, onJumpHandled]);

  // Update content ref when content prop changes
  useEffect(() => {
    contentRef.current = content;

    // If editor is mounted, directly set the value to ensure it updates
    if (editorRef.current) {
      // Preserve cursor position and selection when updating content
      const model = editorRef.current.getModel();
      if (model && model.getValue() !== content) {
        editorRef.current.setValue(content);
      }
    }
  }, [content]);

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
      // TODO look into this further
      // @ts-expect-error: Monaco editor instance is properly loaded at runtime
      range: new monaco.Range(bp.line, 1, bp.line, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: getBreakpointClassName(bp),
        glyphMarginHoverMessage: { value: getBreakpointTooltip(bp) },
      },
    }));

    // NEW: Execution decoration – only if the paused file matches the open file.
    const executionDecorations = [];
    // Here we compare executionFile with the current file. Adjust if needed.
    if (
      executionFile &&
      currentFile &&
      executionFile.endsWith(currentFile) &&
      executionLine
    ) {
      executionDecorations.push({
        // TODO look into this further
        // @ts-expect-error: Monaco editor instance is properly loaded at runtime
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

  // Add new effect to scroll to the execution line when it changes
  useEffect(() => {
    // Only scroll to the execution line if:
    // 1. We have a valid editor instance
    // 2. There is an execution line
    // 3. The current file matches the execution file
    if (
      editorRef.current &&
      executionLine !== null &&
      executionLine !== undefined &&
      executionFile &&
      currentFile &&
      executionFile.endsWith(currentFile)
    ) {
      // Reveal the line in the center of the editor viewport
      editorRef.current.revealLineInCenter(executionLine);
    }
  }, [executionLine, executionFile, currentFile]);

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
    editor.setValue(contentRef.current);

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
        readOnly: true,
      }}
    />
  );
}
