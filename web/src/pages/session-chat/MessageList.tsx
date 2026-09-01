import { useEffect, useRef } from "react";
import type { SessionMessage } from "../../api.js";
import { MessageItem } from "./MessageItem.js";

/** @implements spec/feature/session-message-webui-chat.md §1.2 message viewport */
export function MessageList({ messages, onAnswer, onPermission }: { messages: SessionMessage[]; onAnswer: (message: SessionMessage, value: number | number[]) => Promise<void>; onPermission: (message: SessionMessage, allow: boolean) => Promise<void> }) {
  const bottom = useRef<HTMLDivElement>(null);
  // ブラウザ固有の戻り値を React が cleanup として扱わないよう、明示的に何も返さない。
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} onAnswer={onAnswer} onPermission={onPermission} />
      ))}
      <div ref={bottom} />
    </div>
  );
}
