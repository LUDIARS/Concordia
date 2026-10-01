/** @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02 登録外チームの拒否 */
/**
 * C-4: a selection that returns never carries a team outside the project's
 * registration (the binding's own team or its candidates).
 */
export default {
  post(result: unknown, binding: unknown): boolean {
    const before = binding as { teamId?: string | null; teamCandidates?: readonly string[] } | null;
    const team = (result as { teamId?: unknown } | null)?.teamId;
    if (!before) return false;
    if (team === null || team === before.teamId) return true;
    return typeof team === "string" && before.teamId === null && (before.teamCandidates ?? []).includes(team);
  },
};
