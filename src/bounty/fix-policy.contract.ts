/** @implements SPEC-BOUNTY-HOTFIX */
/** C-3: a hotfix starts only when every condition of spec/feature/bug-bounty.md §6 holds. */
export default {
  post(
    result: unknown,
    input: {
      status?: unknown; verdict?: unknown; hotfixEligible?: unknown; revisorWorkflow?: unknown;
      actioTaskRef?: unknown; hotfixStartedAt?: unknown; hotfixesToday?: unknown; dailyLimit?: unknown;
    } | undefined,
  ): boolean {
    if (!result || typeof result !== "object") return false;
    const ok = (result as { ok?: unknown }).ok === true;
    const all = input?.verdict === "accepted"
      && input.hotfixEligible === true
      && input.revisorWorkflow === "revisor"
      && typeof input.actioTaskRef === "string" && input.actioTaskRef.length > 0
      && input.status === "fix_pending"
      && input.hotfixStartedAt === null
      && Number(input.hotfixesToday) < Number(input.dailyLimit);
    return ok === all;
  },
};
