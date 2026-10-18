/** @implements spec/feature/patrol-chat.md — MCP に許すツールは Notion の読み取りだけ (chat-knowledge-C-12) */
export default {
  post(result: unknown): boolean {
    const tools = (result as { allowedTools?: unknown }).allowedTools;
    return Array.isArray(tools) && tools.length > 0
      && tools.every((t) => typeof t === "string" && /^mcp__claude_ai_Notion__notion-(fetch|search)$/.test(t));
  },
};
