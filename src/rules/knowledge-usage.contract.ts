/** @implements spec/feature/patrol-chat.md — 知識の使いどころ (chat-knowledge-C-8) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [kind, input] = args as [string, { replies: string[]; previousBotText: string | null }];
    if (kind !== "reply") return result === null;
    if (!Array.isArray(result)) return false;
    const allowed = new Set([...input.replies, input.previousBotText ?? ""]);
    return result.every((t) => typeof t === "string" && t.trim() !== "" && allowed.has(t));
  },
};
