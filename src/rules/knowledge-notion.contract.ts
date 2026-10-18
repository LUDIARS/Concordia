/** @implements spec/feature/patrol-chat.md — Notion のレート制限 (chat-knowledge-C-5) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [last, now, min] = args as [number | null, number, number];
    if (typeof result !== "number" || result < 0) return false;
    return last === null ? result === 0 : now + result >= last + min;
  },
};
