/** @implements spec/feature/personal-ai-budget.md §3 — 払い出しの判定の事後条件 (CC-PBUDGET-INV-02 / 03) */
/**
 * Properties the table must keep: nobody is dispatched while the global cap is exceeded
 * (whether or not a personal budget is in effect); otherwise a person whose personal budget
 * is not in effect is decided by the subsidiary cap alone (the pre-existing behaviour), and
 * nobody under a personal budget is dispatched with nothing left.
 */
function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as {
      globalOver?: unknown; subsidiaryOver?: unknown;
      person?: { monthlyLimit?: unknown; monthlyUsed?: unknown; rewardBalance?: unknown } | null;
    } | undefined;
    const decision = result as { allow?: unknown } | null;
    if (!input || !decision || typeof decision.allow !== "boolean") return false;
    const limit = whole(input.person?.monthlyLimit);
    const balance = whole(input.person?.rewardBalance);
    const inEffect = Boolean(input.person) && (limit > 0 || balance > 0);
    if (input.globalOver === true) return decision.allow === false;
    if (!inEffect) return decision.allow === (input.subsidiaryOver !== true);
    const monthlyLeft = limit === 0 || whole(input.person?.monthlyUsed) < limit;
    const funded = input.subsidiaryOver === true ? balance > 0 : monthlyLeft || balance > 0;
    return decision.allow === funded;
  },
};
