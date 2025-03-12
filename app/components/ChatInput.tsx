"use client";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { $getRoot } from "lexical";

interface ChatInputProps {
  onChange: (text: string) => void;
}

const initialConfig = {
  namespace: "ChatInput",
  theme: {
    // Add your custom theme classes here if needed.
  },
  onError: (error: any) => {
    console.error(error);
  },
};

export default function ChatInput({ onChange }: ChatInputProps) {
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <OnChangePlugin
        onChange={(editorState) => {
          editorState.read(() => {
            const text = $getRoot().getTextContent();
            onChange(text);
          });
        }}
      />
      <HistoryPlugin />
      <LexicalErrorBoundary>
        <ContentEditable
          className="flex-1 px-3 py-2 text-sm rounded-md border bg-background"
          placeholder="Type your message..."
        />
      </LexicalErrorBoundary>
    </LexicalComposer>
  );
}
