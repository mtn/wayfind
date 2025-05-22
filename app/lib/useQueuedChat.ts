import { Message, useChat, UseChatHelpers } from "ai/react";
import { useRef, useCallback, useEffect, useState } from "react";

// Define a type for queue items to include both message and options
type QueueItem = {
  msg: Message;
  opts?: Parameters<UseChatHelpers["append"]>[1];
};

export function useQueuedChat(opts?: Parameters<typeof useChat>[0]) {
  const chat = useChat(opts); // normal useChat
  const q = useRef<QueueItem[]>([]); // FIFO queue of message+options pairs
  const flushing = useRef(false); // "is streaming" flag
  const [isThinking, setIsThinking] = useState(false);
  const [queueLength, setQueueLength] = useState(0);

  /** flush the queue if idle */
  const flush = useCallback(async () => {
    if (flushing.current || q.current.length === 0) return;
    flushing.current = true;
    const { msg, opts } = q.current.shift()!; // dequeue both message and options
    await chat.append(msg, opts); // forward both to append
  }, [chat]);

  /** enqueue a new user message with its options */
  const send = useCallback(
    (
      content: string | Message,
      opts?: Parameters<UseChatHelpers["append"]>[1],
    ) => {
      const msg: Message =
        typeof content === "string"
          ? { id: crypto.randomUUID(), role: "user", content }
          : content;

      q.current.push({ msg, opts }); // store both message and options
      setQueueLength(q.current.length); // track length
      flush(); // try to send
    },
    [flush],
  );

  /** when streaming ends, try the next item */
  useEffect(() => {
    if (!chat.isLoading && flushing.current) {
      flushing.current = false;
      setQueueLength(q.current.length);
      setIsThinking(false);
      flush();
    }
  }, [chat.isLoading, flush]);

  /** handle errors to prevent queue stalling */
  useEffect(() => {
    if (chat.error && flushing.current) {
      flushing.current = false;
      setQueueLength(q.current.length);
      setIsThinking(false);
      flush();
    }
  }, [chat.error, flush]);

  // Track all parts we've seen to detect transition from thinking to generating
  const seenTextParts = useRef<Set<string>>(new Set());

  // Reset the seen parts when loading state changes to false
  useEffect(() => {
    if (!chat.isLoading) {
      seenTextParts.current = new Set();
    }
  }, [chat.isLoading]);

  // Watch for reasoning parts and detect when text generation begins
  useEffect(() => {
    if (!chat.isLoading) return;

    // Check last message's parts
    const lastMessage = chat.messages[chat.messages.length - 1];
    if (lastMessage?.parts) {
      const parts = lastMessage.parts;

      // Check if we have any text parts (non-reasoning)
      let hasNonReasoningText = false;
      let hasReasoningParts = false;

      type MessagePart = { type: "reasoning" } | { type: "text"; text: string };

      for (const part of parts) {
        const typedPart = part as MessagePart;

        // Track reasoning parts
        if (typedPart.type === "reasoning") {
          hasReasoningParts = true;
        }

        // Track non-reasoning text parts
        if (typedPart.type === "text" && typeof typedPart.text === "string") {
          const textContent = typedPart.text;

          // Only count non-empty text as real generation
          if (textContent.trim().length > 0) {
            // Use the content as an ID to track unique text parts
            seenTextParts.current.add(textContent);
            hasNonReasoningText = true;
          }
        }
      }

      // We're thinking if we have reasoning parts but no text parts yet
      // Once we start seeing text parts, we're no longer in thinking mode
      const nextThinkingState = hasReasoningParts && !hasNonReasoningText;

      // Log state transitions for debugging
      if (isThinking !== nextThinkingState) {
        console.log(
          `Thinking state transition: ${isThinking} -> ${nextThinkingState}`,
          {
            hasReasoningParts,
            hasNonReasoningText,
            numTextParts: seenTextParts.current.size,
          },
        );
      }

      setIsThinking(nextThinkingState);
    }
  }, [chat.messages, chat.isLoading, isThinking]);

  return {
    ...chat,
    send,
    isThinking,
    queueLength,
    isFlushing: flushing.current,
  };
}
