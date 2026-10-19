/** Company sharing decisions; no transport or persistence dependencies. */
export function isSharedSaveAction(action: string): boolean {
  return action === "memoria-note" || action === "repo-memory-good" || action === "repo-memory-bad";
}

export interface SharingVisibility {
  guildId: string;
  sourceGuildId: string;
  targetGuildId: string;
  sourceChannelId: string;
  targetChannelId: string;
  privateSource: boolean;
  sourceAudience: string | null;
  targetAudience: string | null;
}

/** @implements CC-PIN-01 — widening the readership is never implicit. */
export function canSharePinnedContent(input: SharingVisibility): boolean {
  return !input.privateSource && input.guildId === input.sourceGuildId
    && input.guildId === input.targetGuildId && input.sourceChannelId !== input.targetChannelId
    && input.sourceAudience !== null && input.sourceAudience === input.targetAudience;
}

/** @implements CC-PIN-02 — preserve long text as an attachment, not a summary. */
export function sharedContent(text: string, url: string, kind: "pin" | "save"): {
  content: string; attachmentText?: string;
} {
  const heading = kind === "pin" ? "📌 ピン止めされた内容" : "📝 保存操作の対象";
  const prefix = `${heading}\n元の投稿: <${url}>\n\n`;
  if (!text.trim()) return { content: `${prefix}本文はありません。添付・埋め込みは元の投稿をご覧ください。` };
  const quoted = text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
  if (prefix.length + quoted.length <= 2000) return { content: prefix + quoted };
  return { content: `${prefix}本文全文は添付ファイルをご覧ください。`, attachmentText: text };
}
