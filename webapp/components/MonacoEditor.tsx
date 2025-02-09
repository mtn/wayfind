"use client"

import { Editor } from "@monaco-editor/react"

interface EditorProps {
  content: string
  language: string
  onChange: (value: string) => void
}

export function MonacoEditorWrapper({ content, language, onChange }: EditorProps) {
  return (
    <Editor
      height="100%"
      defaultLanguage={language}
      defaultValue={content}
      value={content}
      theme="vs-dark"
      onChange={(value) => onChange(value || "")}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        roundedSelection: false,
        padding: { top: 8 },
        automaticLayout: true,
      }}
    />
  )
}

