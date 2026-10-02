/** @implements spec/feature/usage-budgets.md §3.1 — budget-C-1 予算から引く額 */
/**
 * budget-C-1: the charged amount is tokens × department multiplier × role multiplier, where a
 * multiplier outside (0, 10] counts as 1 and negative tokens count as 0. The bounds are spelled
 * out here so the predicate states the spec instead of echoing the implementation.
 */
const MAX = 10;
const norm = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX ? value : 1;

export default {
  post(result: unknown, tokens: unknown, department: unknown, role: unknown): boolean {
    const base = typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    return typeof result === "number" && Math.abs(result - base * norm(department) * norm(role)) < 1e-9;
  },
};
