/** @implements spec/feature/usage-budgets.md §9 — cap-C-2 会社ごとの稼働セッション数の数え方 */
/**
 * cap-C-2: every active session is counted exactly once, under its subsidiary or under the
 * head office (null) when it carries no subsidiary — the per-company counts sum to the input size.
 */
export default {
  post(result: unknown, input: unknown): boolean {
    const counts = result as Map<string | null, number>;
    const sessions = input as unknown[];
    let total = 0;
    for (const value of counts.values()) {
      if (!Number.isInteger(value) || value <= 0) return false;
      total += value;
    }
    return total === sessions.length;
  },
};
