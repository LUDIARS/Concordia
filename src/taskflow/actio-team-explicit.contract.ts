/** @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02 チーム明示 */
/** C-3: a requested registered team is the team of the selected binding. */
export default {
  post(result: unknown, _binding: unknown, requested?: unknown): boolean {
    if (!requested) return true;
    return (result as { teamId?: unknown } | null)?.teamId === requested;
  },
};
