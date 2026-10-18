/** @implements spec/feature/patrol-chat.md — 隣のページの補助取得 (chat-knowledge-C-9) */
interface Chunk { doc_key: string; scope: string; title: string; body: string }

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [picked, , opts] = args as [Chunk[], Chunk[], { allowHq: boolean; limit?: number; maxBytes?: number; maxNeighbors?: number }];
    const out = result as Chunk[];
    const limit = opts.limit ?? 5;
    const maxBytes = opts.maxBytes ?? 2400;
    const maxNeighbors = opts.maxNeighbors ?? 2;
    const pickedKeys = new Set(picked.map((c) => c.doc_key));
    const added = out.filter((c) => !pickedKeys.has(c.doc_key));
    const bytes = out.reduce((n, c) => n + Buffer.byteLength(c.title, "utf8") + Buffer.byteLength(c.body, "utf8"), 0);
    const addedKeys = added.map((c) => c.doc_key);
    return out.length <= Math.max(limit, picked.length)
      && added.length <= maxNeighbors
      && new Set(addedKeys).size === addedKeys.length
      && (opts.allowHq || out.every((c) => c.scope === "public"))
      && (added.length === 0 || bytes <= maxBytes);
  },
};
