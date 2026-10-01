/** @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02 封印失敗の診断 */
/**
 * C-1: a seal failure is reported with a classified code and a human message,
 * never only the historical fixed text.
 */
const FIXED = "Actio task registration or execution claim failed; inspect the existing task/run before retry";

export default {
  post(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const detail = result as { code?: unknown; message?: unknown };
    return typeof detail.code === "string" && detail.code.length > 0
      && typeof detail.message === "string" && detail.message.length > 0 && detail.message !== FIXED;
  },
};
