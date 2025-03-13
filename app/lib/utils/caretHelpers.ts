export function getCaretPosition(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode!, selection.anchorOffset);
  return range.toString().length;
}

export function setCaretPosition(element: HTMLElement, position: number): void {
  let charCount = 0;
  const nodeStack: Node[] = [element];
  let found = false;
  let currentNode: Node | undefined;

  while ((currentNode = nodeStack.pop())) {
    if (currentNode.nodeType === Node.TEXT_NODE) {
      const textLength = currentNode.textContent?.length || 0;
      if (charCount + textLength >= position) {
        const range = document.createRange();
        const selection = window.getSelection();
        range.setStart(currentNode, position - charCount);
        range.collapse(true);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        found = true;
        break;
      }
      charCount += textLength;
    } else {
      // Push child nodes in reverse order
      for (let i = currentNode.childNodes.length - 1; i >= 0; i--) {
        nodeStack.push(currentNode.childNodes[i]);
      }
    }
  }

  if (!found) {
    // If position exceeds text length, set caret at the end.
    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(element);
    range.collapse(false);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
}
