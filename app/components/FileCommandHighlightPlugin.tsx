import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect, useState } from "react";
import { $getRoot, $createTextNode, TextNode } from "lexical";

// A helper that checks if a given text starts with a file command and extracts the candidate.
function extractFileCommand(
  text: string,
): { command: string; candidate: string } | null {
  const match = text.match(/^\/file\s+(\S+)(.*)$/);
  if (match) {
    return { command: match[1], candidate: match[1] };
  }
  return null;
}

// The plugin receives your list of files and a callback to update a local state if needed.
export default function FileCommandHighlightPlugin({
  files,
  onValidityChange,
}: {
  files: any[];
  onValidityChange: (valid: boolean | null) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const root = $getRoot();
        const firstChild = root.getFirstChild();
        if (firstChild && firstChild instanceof TextNode) {
          const text = firstChild.getTextContent();
          const fileCmd = extractFileCommand(text);
          if (fileCmd) {
            // Look for a file with the candidate name (case-insensitive).
            const isValid = files.some(
              (f) =>
                f.type === "file" &&
                f.name.toLowerCase() === fileCmd.candidate.toLowerCase(),
            );
            onValidityChange(isValid);
            // To decorate the command text, we reformat the TextNode.
            // For simplicity, we split the text into two parts: the command and the remainder.
            const fullText = text;
            const commandPartLength = ("/file " + fileCmd.candidate).length;
            if (fullText.length > commandPartLength) {
              // Reconstruct: first part decorated, rest unchanged.
              firstChild.setText(fullText); // reset any prior formatting
              // Mark the command portion. One way is to split the node.
              const [commandNode, remainderNode] =
                firstChild.splitText(commandPartLength);
              // Now apply a CSS class to commandNode using setFormat.
              // Lexical’s built-in formatting flags (bold, italic, etc.) do not support arbitrary classes.
              // Instead, one common approach is to replace commandNode with a custom DecoratorNode.
              // Here we keep it simple and set it to bold as a proxy.
              commandNode.setFormat(commandNode.getFormat() | TextNode.BOLD);
            }
          } else {
            onValidityChange(null);
          }
        } else {
          onValidityChange(null);
        }
      });
    });
  }, [editor, files, onValidityChange]);

  return null;
}
