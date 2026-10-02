/** @implements spec/feature/usage-budgets.md §5.2 — budget-C-3 ツール実行前の判定 */
/**
 * budget-C-3: a tool is denied exactly when the responsible subject has a budget and it is used up,
 * and a denial always carries a reason for the AI. Subjects without a budget are never judged.
 */
export default {
  post(result: unknown, input: unknown): boolean {
    const decision = result as { deny: boolean; reason: string | null };
    const given = input as { subject: unknown; evaluation: { exhausted: boolean } | null };
    const expected = Boolean(given.subject) && given.evaluation?.exhausted === true;
    if (decision.deny !== expected) return false;
    return !decision.deny || (typeof decision.reason === "string" && decision.reason.length > 0);
  },
};
