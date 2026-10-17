/** @implements spec/feature/task-workflow-v3.md CC-AT-PAGE-01 */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (typeof result !== "string" || !result.startsWith("/api/tasks?")) return false;
    const [query, cursor] = args as [URLSearchParams, string | null];
    const params = new URLSearchParams(result.slice("/api/tasks?".length));
    if (params.get("limit") !== "500") return false;
    if (cursor ? params.get("cursor") !== cursor : params.has("cursor")) return false;
    for (const [key, value] of query) {
      if (key !== "limit" && key !== "cursor" && params.get(key) !== value) return false;
    }
    return true;
  },
};
