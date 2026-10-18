/** @implements spec/feature/line-webhook-relay.md — 返信の合流 (line-wh-C-12) */
export default {
  post(result: unknown): boolean {
    if (!Array.isArray(result)) return false;
    const tokens = result.map((reply: { replyToken?: unknown }) => reply?.replyToken);
    return new Set(tokens).size === tokens.length
      && result.every((reply: { replyToken?: unknown; messages?: unknown }) =>
        typeof reply?.replyToken === "string" && Array.isArray(reply.messages)
        && reply.messages.length >= 1 && reply.messages.length <= 5);
  },
};
