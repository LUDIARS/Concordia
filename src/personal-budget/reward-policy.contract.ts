/** @implements spec/feature/personal-ai-budget.md §4 — 報奨の可否の事後条件 (CC-PBUDGET-INV-04 / 07) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as { recipient?: { ok?: unknown }; alreadyGranted?: unknown } | undefined;
    const decision = result as { action?: unknown; tokens?: unknown } | null;
    if (!input || !decision || typeof decision.action !== "string") return false;
    // 同じ根拠では 2 回目を付けない。
    if (input.alreadyGranted !== null && input.alreadyGranted !== undefined) return decision.action !== "grant";
    // 本社所属・個人を特定できない受取人には付けない。
    if (input.recipient?.ok !== true) return decision.action === "skip";
    if (decision.action === "grant") return typeof decision.tokens === "number" && decision.tokens > 0;
    return true;
  },
};
