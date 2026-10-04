import type { SessionMessage } from "../../api.js";

/** Only the backend's one-to-one provenance link identifies an echoed player post. */
export function isTranscriptEcho(message: SessionMessage): boolean {
  const originalId = message.metadata?.echo_of_message_id;
  return message.metadata?.echo_identity_verified === true
    && message.author_type === "user" && typeof originalId === "number"
    && Number.isSafeInteger(originalId) && originalId > 0 && originalId !== message.id;
}
