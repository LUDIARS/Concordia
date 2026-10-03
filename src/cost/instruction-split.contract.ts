/** @implements spec/feature/usage-budgets.md §3.2 — budget-C-6 区間の消費を指示の回数で分ける */
/**
 * budget-C-6: a turn's tokens are shared among the people who instructed in that turn, in proportion to how many
 * instructions each gave (A twice, B once → 2/3 and 1/3). Every share is positive, each person appears once,
 * and the shares add up to the tokens (nothing is created or lost). No instruction → no shares.
 */
interface Share { userId: string; tokens: number }

export default {
  post(result: unknown, tokens: unknown, userIds: unknown): boolean {
    if (!Array.isArray(result) || !Array.isArray(userIds) || typeof tokens !== "number") return false;
    const shares = result as Share[];
    const counts = new Map<string, number>();
    for (const id of userIds as string[]) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (counts.size === 0 || !(tokens > 0)) return shares.length === 0;
    if (shares.length !== counts.size) return false;
    const total = (userIds as string[]).length;
    const tolerance = 1e-9 * Math.max(1, tokens);
    const sum = shares.reduce((acc, share) => acc + share.tokens, 0);
    if (Math.abs(sum - tokens) > tolerance) return false;
    return shares.every((share) => {
      const count = counts.get(share.userId);
      return count !== undefined && share.tokens > 0 && Math.abs(share.tokens - (tokens * count) / total) <= tolerance;
    });
  },
};
