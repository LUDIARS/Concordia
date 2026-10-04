/** @implements spec/feature/personal-ai-budget.md §3 — 消費の差分の事後条件 (CC-PBUDGET-INV-05) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (typeof result !== "number" || !Number.isInteger(result) || result < 0) return false;
    const last = typeof args[0] === "number" && Number.isFinite(args[0]) ? args[0] : 0;
    const total = typeof args[1] === "number" && Number.isFinite(args[1]) ? args[1] : 0;
    // 累積が増えていなければ数えない (負の差分は 0)。
    return total > last || result === 0;
  },
};
