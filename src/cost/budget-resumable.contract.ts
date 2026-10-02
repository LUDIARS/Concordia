/** @implements spec/feature/usage-budgets.md §5.3 — budget-C-5 再開できる状態 */
/**
 * budget-C-5: a suspension is resumable only while it is not resumed yet, knows its conversation
 * id, and the budget that stopped it is no longer used up.
 */
export default {
  post(result: unknown, input: unknown): boolean {
    if (result !== true) return true;
    const given = input as {
      suspension: { resumed_at?: number | null; conversation_id: string | null } | null;
      evaluation: { exhausted: boolean } | null;
    };
    return given.suspension !== null
      && !given.suspension.resumed_at
      && typeof given.suspension.conversation_id === "string"
      && given.evaluation?.exhausted !== true;
  },
};
