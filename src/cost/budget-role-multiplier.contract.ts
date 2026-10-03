/** @implements spec/feature/usage-budgets.md §3.1 — budget-role-C-1 属性の倍率 (Discord のロール) */
/**
 * budget-role-C-1: among the roles the person holds, only roles with a valid multiplier in (0, 10] count,
 * and the lowest of them wins. Holding none of them means 1.
 */
const MAX = 10;
const valid = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX;

export default {
  post(result: unknown, roleIds: unknown, multipliers: unknown): boolean {
    if (!Array.isArray(roleIds) || !(multipliers instanceof Map)) return false;
    const held = roleIds.map((id) => multipliers.get(id)).filter(valid);
    const expected = held.length > 0 ? Math.min(...held) : 1;
    return result === expected;
  },
};
