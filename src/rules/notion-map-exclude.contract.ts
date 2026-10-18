/** @implements spec/feature/patrol-chat.md — Notion 記事マップの除外 (chat-knowledge-C-7) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [title, path, words] = args as [string, string, string[]];
    const hay = `${path}\n${title}`.normalize("NFKC").toLowerCase();
    const hit = words.some((w) => w.trim() !== "" && hay.includes(w.trim().normalize("NFKC").toLowerCase()));
    return result === hit;
  },
};
