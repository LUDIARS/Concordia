/** @implements spec/feature/discord-chat-relay.md — お知らせチャンネル (dcr-C-8) */
/** The accepted shape is restated here rather than imported, so the predicate checks the spec. */
function textItems(value: unknown, max: number, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= max && value.every((item: { text?: unknown }) =>
    !!item && typeof item === "object" && !Array.isArray(item)
    && typeof item.text === "string" && item.text.length >= 1 && item.text.length <= maxLength);
}

function wellFormed(value: unknown): value is { replies: unknown[]; linePush?: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { replies, linePush } = value as { replies?: unknown; linePush?: unknown };
  return textItems(replies, 5, 2000) && (linePush === undefined || textItems(linePush, 3, 1000));
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
    const answer = result as { replies?: unknown[]; linePush?: unknown[] } | null;
    return !!answer && Array.isArray(answer.replies) && Array.isArray(answer.linePush)
      && answer.replies.length === parsed.replies.length
      && answer.linePush.length === (parsed.linePush?.length ?? 0);
  },
};
