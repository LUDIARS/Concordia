/** @implements spec/feature/usage-budgets.md §9 — cap-C-1 会社ごとの同時セッション上限の判定 */
/**
 * cap-C-1: a launch is refused exactly when the company has a cap (max > 0) and its active
 * sessions already reach it, and a refusal always carries a reason naming the cap.
 */
export default {
  post(result: unknown, input: unknown): boolean {
    const decision = result as { allowed: boolean; reason?: string };
    const row = input as { active: number; max: number };
    const expectedRefusal = row.max > 0 && row.active >= row.max;
    if (decision.allowed === expectedRefusal) return false;
    return decision.allowed || (typeof decision.reason === "string" && decision.reason.includes(`(${row.max})`));
  },
};
