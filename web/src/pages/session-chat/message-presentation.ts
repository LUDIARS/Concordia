import type { SessionMessage } from "../../api.js";
import { isFinalReport } from "./response-turns.js";
import { isCcInjection } from "./cc-injection.js";
import { isTranscriptEcho } from "./message-echo.js";
export { isCcInjection } from "./cc-injection.js";

export type MessageTone = "human" | "ai" | "system";

export function messageTone(message: SessionMessage): MessageTone {
  if (isCcInjection(message)) return "system";
  if (message.author_type === "user") return "human";
  if (message.author_type === "assistant" || message.author_type === "summary") return "ai";
  return "system";
}

export interface ChatDisplayOptions {
  intermediate?: boolean;
  inject_transcript?: boolean;
  thinking?: boolean;
}

/** Department display preferences must not hide human input or actionable/failure cards. */
export function visibleChatMessages(messages: SessionMessage[], options: ChatDisplayOptions): SessionMessage[] {
  return messages.filter((message) => {
    if (isTranscriptEcho(message)) return false;
    if (isCcInjection(message)) return options.inject_transcript !== false;
    if (message.author_type === "thinking" && options.thinking === false) return false;
    if (options.intermediate !== false || isFinalReport(message)) return true;
    if (message.metadata?.is_error === true) return true;
    return !["assistant", "thinking", "tool", "task", "delegation"].includes(message.author_type);
  });
}
