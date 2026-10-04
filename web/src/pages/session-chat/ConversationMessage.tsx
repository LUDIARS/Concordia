import { fmtTs, type SessionMessage } from "../../api.js";
import { InlineAttachments } from "./Attachments.js";
import { isCcInjection, messageTone } from "./message-presentation.js";
import { isFinalReport } from "./response-turns.js";
import { ChatMarkdown } from "./ChatMarkdown.js";

/** Human and AI answers share a readable block layout, with explicit role labels as well as color. */
export function ConversationMessage({ message }: { message: SessionMessage }) {
  const tone = messageTone(message);
  const label = tone === "human" ? "プレイヤー" : tone === "ai" ? "AI" : "システム";
  if (isCcInjection(message)) {
    return (
      <details className="rounded-xl border border-border bg-surface/60 px-4 py-3 text-sm">
        <summary className="cursor-pointer text-subtle">
          <span className="font-semibold">Cc 注入</span>
          <span className="ml-2 text-xs">{fmtTs(message.ts)} · 内容を表示</span>
        </summary>
        <div className="mt-3 text-subtle"><ChatMarkdown content={message.content} /></div>
        <InlineAttachments attachments={message.attachments} />
      </details>
    );
  }
  const colors = tone === "human"
    ? "border-emerald-400/30 border-l-emerald-400 bg-emerald-400/[0.07]"
    : tone === "ai" ? "border-violet-400/30 border-l-violet-400 bg-violet-400/[0.07]"
      : "border-border border-l-border bg-surface";
  const labelColor = tone === "human" ? "text-emerald-300" : tone === "ai" ? "text-violet-300" : "text-subtle";
  return (
    <article aria-label={`${label}のメッセージ`} className={`rounded-xl border border-l-[3px] px-4 py-4 sm:px-5 ${colors}`}>
      <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={`font-semibold ${labelColor}`}>{label}</span>
        <span className="text-subtle">{message.author_label}</span>
        {isFinalReport(message) && <span className="rounded-full bg-violet-400/15 px-2 py-0.5 text-violet-200">回答</span>}
        <time className="ml-auto text-subtle" dateTime={new Date(message.ts * 1000).toISOString()}>{fmtTs(message.ts)}</time>
      </header>
      <ChatMarkdown content={message.content} />
      <InlineAttachments attachments={message.attachments} />
    </article>
  );
}
