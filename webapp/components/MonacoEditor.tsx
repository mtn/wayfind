"use client";

import { useEffect, useRef } from "react";
import { Editor } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import { IBreakpoint } from "@/app/page";

interface EditorProps {
  content: string;
  language: string;
  onChange: (value: string) => void;
  breakpoints: IBreakpoint[];
  onBreakpointChange: (lineNumber: number) => void;
}

export function MonacoEditorWrapper({
  content,
  language,
  onChange,
  breakpoints,
  onBreakpointChange,
}: EditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<string[]>([]);

  useEffect(() => {
    if (editorRef.current) {
      const editor = editorRef.current;

      // Clear existing decorations
      decorationsRef.current = editor.deltaDecorations(
        decorationsRef.current,
        [],
      );

      // Add new decorations for breakpoints
      const decorations = breakpoints.map((bp) => {
        return {
          range: {
            startLineNumber: bp.line,
            startColumn: 1,
            endLineNumber: bp.line,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            glyphMarginClassName: getBreakpointClassName(bp),
            glyphMarginHoverMessage: { value: getBreakpointTooltip(bp) },
          },
        };
      });

      decorationsRef.current = editor.deltaDecorations([], decorations);
    }
  }, [breakpoints]);

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

    // Add click handler for both gutter and line numbers
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
        glyphMargin: true, // Enable gutter for breakpoints
        scrollBeyondLastLine: false,
        roundedSelection: false,
        padding: { top: 8 },
        automaticLayout: true,
      }}
    />
  );
}
