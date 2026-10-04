/** @implements spec/feature/personal-ai-budget.md §6 — 本社の調整の事後条件 (CC-PBUDGET-INV-06 / 02) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as {
      actorAuthorized?: unknown; tokens?: unknown; reason?: unknown; rewardBalance?: unknown;
    } | undefined;
    const decision = result as { ok?: unknown; applied?: unknown } | null;
    if (!input || !decision || typeof decision.ok !== "boolean") return false;
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    // 権限の無い操作者・理由の無い調整は受けない。
    if (input.actorAuthorized !== true || !reason) return decision.ok === false;
    if (!decision.ok) return true;
    if (typeof decision.applied !== "number" || decision.applied === 0) return false;
    const balance = typeof input.rewardBalance === "number" && input.rewardBalance > 0 ? Math.floor(input.rewardBalance) : 0;
    // 減額は残高 0 まで。 増額は依頼どおり。
    return decision.applied > 0 ? decision.applied === input.tokens : -decision.applied <= balance;
  },
};
