/** @implements spec/feature/discord-session-task-post.md §3.6 — Cc 由来 inject の 1 行通知の事後条件 */
/**
 * C-12: the summary posted to Discord is one line of at most 150 characters. The limit is
 * spelled out here rather than imported so the predicate states the spec instead of
 * echoing the implementation it checks.
 */
const SUMMARY_MAX = 150;

export default {
  post(result: unknown): boolean {
    return typeof result === "string"
      && !/[\r\n]/.test(result)
      && Array.from(result).length <= SUMMARY_MAX;
  },
};
