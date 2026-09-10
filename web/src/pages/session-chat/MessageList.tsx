import { useEffect, useRef } from "react";
import type { SessionMessage } from "../../api.js";
import { MessageItem } from "./MessageItem.js";
import { AttachmentMessageItem, type AttachmentMessage } from "./Attachments.js";

/** @implements spec/feature/session-message-webui-chat.md §1.2 message viewport */
export function MessageList({ messages, onAnswer, onPermission, attachmentMessages = [], sessionId = "" }: { messages: SessionMessage[]; attachmentMessages?: AttachmentMessage[]; sessionId?: string; onAnswer: (message: SessionMessage, value: number | number[]) => Promise<void>; onPermission: (message: SessionMessage, allow: boolean) => Promise<void> }) {
  const bottom = useRef<HTMLDivElement>(null);
  // ブラウザ固有の戻り値を React が cleanup として扱わないよう、明示的に何も返さない。
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, attachmentMessages.length]);
  // ts は秒精度なので同秒の本文/資料が入れ替わらないよう id も見て安定させる。
  const items = [
    ...messages.map((message) => ({ ts: message.ts, id: message.id, key: `message:${message.id}`, node: <MessageItem message={message} onAnswer={onAnswer} onPermission={onPermission} /> })),
    ...attachmentMessages.map((message) => ({ ts: message.ts, id: message.id, key: `attachment:${message.id}`, node: <AttachmentMessageItem sessionId={sessionId} message={message} /> })),
  ].sort((a, b) => a.ts - b.ts || a.id - b.id);
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 py-4">
      {items.map((item) => <div key={item.key}>{item.node}</div>)}
      <div ref={bottom} />
    </div>
  );
}
