import React from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";

type LexicalEditorProps = {
  initialValue: string;
  onChange: (value: string) => void;
};

function Editor({ onChange }: { onChange: (value: string) => void }) {
  return (
    <>
      <OnChangePlugin
        onChange={(editorState) => {
          editorState.read(() => {
            // Convert editorState to plain text.
            const text = editorState.toString();
            onChange(text);
          });
        }}
      />
      {/* Render the contenteditable area */}
      <ContentEditable className="bg-background text-foreground p-2 border rounded" />
      <HistoryPlugin />
    </>
  );
}

export const LexicalEditor: React.FC<LexicalEditorProps> = ({
  initialValue,
  onChange,
}) => {
  const initialConfig = {
    namespace: "ChatInputEditor",
    theme: {},
    onError: (error: any) => console.error(error),
    // Pre-populate the editor with the initial value.
    editorState: JSON.stringify({
      root: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                text: initialValue,
                type: "text",
                version: 1,
              },
            ],
            direction: "ltr",
            format: 0,
            indent: 0,
            type: "paragraph",
            version: 1,
          },
        ],
        direction: "ltr",
        format: 0,
        indent: 0,
        type: "root",
        version: 1,
      },
    }),
  };

  return (
    <div className="w-full">
      <LexicalComposer initialConfig={initialConfig}>
        <PlainTextPlugin
          contentEditable={<Editor onChange={onChange} />}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </LexicalComposer>
    </div>
  );
};
