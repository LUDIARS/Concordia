/** @implements spec/feature/delegation.md#completed-報告の成果証跡 — 証跡ポリシーの observe 契約 (dsr-C-2) */
interface Input { category: string | null | undefined; reviewOnly: boolean }

export default {
  post(result: unknown, input: Input): boolean {
    if (!result || typeof result !== "object") return false;
    const policy = result as { checked?: unknown; branchRequired?: unknown; outcomeRequired?: unknown };
    const waived = input.category === "parttimer" || input.reviewOnly;
    return policy.checked === true
      && policy.branchRequired === !waived
      && policy.outcomeRequired === waived;
  },
};
