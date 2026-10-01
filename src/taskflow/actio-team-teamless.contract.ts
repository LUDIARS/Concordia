/** @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02 チーム未指定 */
/** C-2: without a requested team the selection keeps the binding's team (team-less stays team-less). */
export default {
  post(result: unknown, binding: unknown, requested?: unknown): boolean {
    if (requested) return true;
    const before = binding as { teamId?: unknown } | null;
    const after = result as { teamId?: unknown } | null;
    return !!before && !!after && after.teamId === before.teamId;
  },
};
