/** @implements spec/feature/line-webhook-relay.md — サービスの応答と LINE への返信 (line-wh-C-5) */
/** The accepted shape is restated here rather than imported, so the predicate checks the spec. */
function wellFormed(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const replies = (value as { replies?: unknown }).replies;
  return Array.isArray(replies) && replies.every((reply: { replyToken?: unknown; messages?: unknown }) =>
    !!reply && typeof reply.replyToken === "string" && reply.replyToken !== ""
    && Array.isArray(reply.messages) && reply.messages.length >= 1 && reply.messages.length <= 5
    && reply.messages.every((message: unknown) => !!message && typeof message === "object" && !Array.isArray(message)));
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const body = args[0];
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(Buffer.from(body as Uint8Array).toString("utf8"));
    } catch {
      return result === null;
    }
    if (!wellFormed(parsed)) return result === null;
    const replies = (parsed as { replies: unknown[] }).replies;
    return Array.isArray(result) && result.length === replies.length;
  },
};
