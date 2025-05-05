import { Message, useChat, UseChatHelpers } from "ai/react";
import { useRef, useCallback, useEffect } from "react";

// Define a type for queue items to include both message and options
type QueueItem = {
  msg: Message;
  opts?: Parameters<UseChatHelpers["append"]>[1];
};

export function useQueuedChat(opts?: Parameters<typeof useChat>[0]) {
  const chat = useChat(opts); // normal useChat
  const q = useRef<QueueItem[]>([]); // FIFO queue of message+options pairs
  const flushing = useRef(false); // "is streaming" flag

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
      flush(); // try to send
    },
    [flush],
  );

  /** when streaming ends, try the next item */
  useEffect(() => {
    if (!chat.isLoading && flushing.current) {
      flushing.current = false;
      flush();
    }
  }, [chat.isLoading, flush]);

  /** handle errors to prevent queue stalling */
  useEffect(() => {
    if (chat.error && flushing.current) {
      flushing.current = false;
      flush();
    }
  }, [chat.error, flush]);

  return { ...chat, send }; // expose new API
}
