/** @implements spec/feature/patrol-chat.md — 関連断片の選択 (chat-knowledge-C-4) */
interface Chunk { scope: string; title: string; body: string }

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const query = args[1] as { allowHq: boolean; limit?: number; maxBytes?: number };
    const picked = (result as Array<{ chunk: Chunk }>).map((s) => s.chunk);
    const limit = query.limit ?? 5;
    const maxBytes = query.maxBytes ?? 2400;
    const bytes = picked.reduce((n, c) => n + Buffer.byteLength(c.title, "utf8") + Buffer.byteLength(c.body, "utf8"), 0);
    return picked.length <= limit && bytes <= maxBytes && (query.allowHq || picked.every((c) => c.scope === "public"));
  },
};
