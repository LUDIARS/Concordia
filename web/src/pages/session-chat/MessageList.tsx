import { useEffect, useRef } from "react";
import type { SessionMessage } from "../../api.js";
import { MessageItem } from "./MessageItem.js";
import { AttachmentMessageItem, type AttachmentMessage } from "./Attachments.js";
import { responseBlocks, type ResponseBlock } from "./response-turns.js";

/** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
export function MessageList({ messages, onAnswer, onPermission, attachmentMessages = [], sessionId = "", working = false }: { messages: SessionMessage[]; attachmentMessages?: AttachmentMessage[]; sessionId?: string; working?: boolean; onAnswer: (message: SessionMessage, value: number | number[]) => Promise<void>; onPermission: (message: SessionMessage, allow: boolean) => Promise<void> }) {
  const bottom = useRef<HTMLDivElement>(null);
  // ブラウザ固有の戻り値を React が cleanup として扱わないよう、明示的に何も返さない。
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, attachmentMessages.length, working]);
  // ts は秒精度なので同秒の本文/資料が入れ替わらないよう id も見て安定させる。
  const items = [
    ...splitFoldedBlocksAtAttachments(responseBlocks(messages), attachmentMessages).map((block) => ({
      ts: block.messages[0].ts, id: block.messages[0].id, key: `${block.key}:${block.folded}`,
      node: block.folded ? (
        <details className="rounded border border-border p-2 text-sm">
          <summary className="cursor-pointer text-subtle">作業内容 · {block.messages.length} 件</summary>
          <div className="mt-2 space-y-2">{block.messages.map((message) => <MessageItem key={message.id} message={message} onAnswer={onAnswer} onPermission={onPermission} />)}</div>
        </details>
      ) : <>{block.messages.map((message) => <MessageItem key={message.id} message={message} onAnswer={onAnswer} onPermission={onPermission} />)}</>,
    })),
    ...attachmentMessages.map((message) => ({ ts: message.ts, id: message.id, key: `attachment:${message.id}`, node: <AttachmentMessageItem sessionId={sessionId} message={message} /> })),
  ].sort((a, b) => a.ts - b.ts || a.id - b.id);
  return (
    <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 py-4">
      {items.map((item) => <div key={item.key}>{item.node}</div>)}
      {working && <div role="status" aria-live="polite" className="flex items-center gap-2 px-2 py-2 text-sm text-subtle"><span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />作業中...</div>}
      <div ref={bottom} />
    </div>
  );
}

/** Keep separately persisted attachment posts at their original point in the combined timeline. */
function splitFoldedBlocksAtAttachments(blocks: ResponseBlock[], attachments: AttachmentMessage[]): ResponseBlock[] {
  if (attachments.length === 0) return blocks;
  const positions = attachments.map(({ ts, id }) => ({ ts, id }));
  return blocks.flatMap((block) => {
    if (!block.folded || block.messages.length < 2) return [block];
    const chunks: ResponseBlock[] = [];
    let messages: SessionMessage[] = [];
    for (const message of block.messages) {
      const previous = messages.at(-1);
      if (previous && positions.some((position) => compareTimeline(previous, position) < 0 && compareTimeline(position, message) < 0)) {
        const first = messages[0];
        if (first) chunks.push({ key: `work:${first.id}`, messages, folded: true });
        messages = [];
      }
      messages.push(message);
    }
    const first = messages[0];
    if (first) chunks.push({ key: `work:${first.id}`, messages, folded: true });
    return chunks;
  });
}

function compareTimeline(left: { ts: number; id: number }, right: { ts: number; id: number }): number {
  return left.ts - right.ts || left.id - right.id;
}
