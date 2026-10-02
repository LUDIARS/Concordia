/** @implements spec/feature/usage-budgets.md §5.3 — budget-C-4 再開を押せる人 */
/** budget-C-4: only the launcher, a person who gave instructions, or an administrator may resume. */
export default {
  post(result: unknown, input: unknown): boolean {
    const given = input as { suspension: { participants: string[] }; actorUserId: string; actorIsAdmin: boolean };
    const expected = given.actorIsAdmin || (given.actorUserId.length > 0 && given.suspension.participants.includes(given.actorUserId));
    return result === expected;
  },
};
