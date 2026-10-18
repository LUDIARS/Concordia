/** @implements spec/feature/patrol-chat.md — 相談への記事マップの共有 (chat-knowledge-C-10) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [input, maxBytes] = args as [{ pages: unknown[] }, number | undefined];
    if (input.pages.length === 0) return result === null;
    return typeof result === "string" && Buffer.byteLength(result, "utf8") <= (maxBytes ?? 16_000);
  },
};
