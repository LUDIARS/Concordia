/** @implements spec/feature/discord-chat-relay.md — サービスの応答と Discord への投稿 (dcr-C-4) */
/** The accepted shape is restated here rather than imported, so the predicate checks the spec. */
function wellFormed(value: unknown): value is { replies: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const replies = (value as { replies?: unknown }).replies;
  return Array.isArray(replies) && replies.length <= 5 && replies.every((reply: { text?: unknown }) =>
    !!reply && typeof reply === "object" && !Array.isArray(reply)
    && typeof reply.text === "string" && reply.text.length >= 1 && reply.text.length <= 2000);
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(Buffer.from(args[0] as Uint8Array).toString("utf8"));
    } catch {
      return result === null;
    }
    if (!wellFormed(parsed)) return result === null;
    return Array.isArray(result) && result.length === parsed.replies.length;
  },
};
