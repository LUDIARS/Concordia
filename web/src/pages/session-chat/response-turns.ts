import type { SessionMessage, SessionRow } from "../../api.js";

/** @implements spec/feature/session-message-webui-chat.md §1.2.1 — evidence-based response presentation */
export function isFinalReport(message: SessionMessage): boolean {
  return message.author_type === "summary"
    || (message.author_type === "assistant" && message.metadata?.phase === "final_answer");
}

export interface ResponseBlock {
  key: string;
  messages: SessionMessage[];
  folded: boolean;
}

const WORK_TYPES = new Set(["assistant", "thinking", "tool", "task", "delegation"]);

/** Keep human input and actionable cards outside work details; never discard original messages. */
export function responseBlocks(messages: SessionMessage[]): ResponseBlock[] {
  const blocks: ResponseBlock[] = [];
  const completedWork = new Set<number>();
  let hasFinal = false;
  for (const message of [...messages].reverse()) {
    if (isFinalReport(message)) hasFinal = true;
    else if (message.author_type === "user") hasFinal = false;
    else if (hasFinal) completedWork.add(message.id);
  }
  let work: SessionMessage[] = [];
  const flush = (): void => {
    if (!work.length) return;
    blocks.push({ key: `work:${work[0].id}`, messages: work, folded: true });
    work = [];
  };
  for (const message of messages) {
    if (isFinalReport(message)) {
      flush();
      blocks.push({ key: `message:${message.id}`, messages: [message], folded: false });
    } else if (completedWork.has(message.id) && WORK_TYPES.has(message.author_type) && !message.attachments?.length) {
      work.push(message);
    } else {
      flush();
      blocks.push({ key: `message:${message.id}`, messages: [message], folded: false });
    }
  }
  flush();
  return blocks;
}

/** pendingAfter is a local accepted input, cleared by a subsequent terminal message. */
export function isResponseWorking(
  messages: SessionMessage[], status: SessionRow["status"] | undefined, pendingAfter: number | null = null,
): boolean {
  if (status !== "active") return false;
  const latest = [...messages].reverse().find((message) =>
    isFinalReport(message) || WORK_TYPES.has(message.author_type)
    || ["user", "question", "permission"].includes(message.author_type));
  if (pendingAfter !== null && (!latest || latest.id <= pendingAfter)) return true;
  if (!latest || isFinalReport(latest)) return false;
  if (latest.author_type === "question") return latest.metadata?.answered === true;
  if (latest.author_type === "permission") return false;
  return true;
}
