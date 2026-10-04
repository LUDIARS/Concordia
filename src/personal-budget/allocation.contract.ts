/** @implements spec/feature/personal-ai-budget.md §3 — 割り当ての事後条件 (CC-PBUDGET-INV-01 / 02) */
/**
 * The predicate restates the spec instead of calling the implementation: every counted
 * token lands in exactly one bucket, the reward debit never exceeds the balance, and the
 * reward bucket is only touched once the monthly allowance cannot cover the delta.
 */
function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as {
      delta?: unknown; monthlyLimit?: unknown; monthlyUsed?: unknown; rewardBalance?: unknown; subsidiaryOver?: unknown;
    } | undefined;
    const allocation = result as { monthly?: unknown; reward?: unknown } | null;
    if (!input || !allocation || typeof allocation.monthly !== "number" || typeof allocation.reward !== "number") return false;
    const delta = whole(input.delta);
    const balance = whole(input.rewardBalance);
    if (allocation.monthly < 0 || allocation.reward < 0) return false;
    if (allocation.monthly + allocation.reward !== delta) return false;
    if (allocation.reward > balance) return false;
    if (input.subsidiaryOver === true) return true;
    const limit = whole(input.monthlyLimit);
    if (limit === 0) return allocation.reward === 0;
    const remaining = Math.max(0, limit - whole(input.monthlyUsed));
    // 月間分の残りを使い切るまでは報酬分を引かない。
    return allocation.reward === 0 || allocation.monthly >= Math.min(delta, remaining);
  },
};
