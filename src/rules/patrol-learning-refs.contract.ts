/** @implements spec/feature/patrol-chat.md — 学習結果に残す知識の出典 (chat-knowledge-C-11) */
export default {
  post(result: unknown): boolean {
    if (!Array.isArray(result)) return false;
    const keys = result.map((r) => (r as { doc_key?: unknown }).doc_key);
    return result.every((r) => r && typeof r === "object" && Object.keys(r).sort().join(",") === "doc_key,title")
      && new Set(keys).size === keys.length;
  },
};
