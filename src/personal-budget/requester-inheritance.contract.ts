/** @implements spec/feature/personal-ai-budget.md §3 — 委託の子への依頼者の引き継ぎの事後条件 */
/**
 * The body's requester always wins (nothing is inherited); without one, the result is either
 * null or a complete (company, user) pair — never half of one.
 */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const input = args[0] as { bodyRequesterUserId?: unknown; parentMetadata?: unknown } | undefined;
    if (!input) return false;
    const bodyGiven = typeof input.bodyRequesterUserId === "string" && input.bodyRequesterUserId.trim() !== "";
    if (bodyGiven || !input.parentMetadata) return result === null;
    if (result === null) return true;
    const pair = result as { subsidiaryId?: unknown; discordUserId?: unknown };
    return typeof pair.subsidiaryId === "string" && pair.subsidiaryId !== ""
      && typeof pair.discordUserId === "string" && pair.discordUserId !== "";
  },
};
