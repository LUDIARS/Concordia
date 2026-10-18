/** @implements spec/feature/patrol-chat.md — Notion の取得経路の優先順位 (chat-knowledge-C-13) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [ref] = args as [{ url: string | null }];
    const routes = result as string[];
    let isPublic = false;
    try {
      const u = new URL(ref.url ?? "");
      isPublic = u.protocol === "https:" && /(^|\.)notion\.site$/i.test(u.hostname);
    } catch {
      isPublic = false;
    }
    return isPublic ? routes.join(",") === "public,mcp" : routes.join(",") === "mcp";
  },
};
