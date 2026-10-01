/** @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02 0/1 チームの既存挙動 */
/**
 * C-5: discovered bindings for projects with 0 or 1 registered teams keep the
 * previous shape (that team or null, no candidates); 2+ teams stay team-less.
 */
type Registered = { code: string; teamIds: readonly string[] };
type Binding = { projectId: string; teamId: string | null; teamCandidates?: readonly string[] };

export default {
  post(result: unknown, _configured: unknown, _repositories: unknown, registered: unknown): boolean {
    if (!Array.isArray(result) || !Array.isArray(registered)) return false;
    for (const binding of result as Binding[]) {
      const project = (registered as Registered[]).find(item => item.code === binding.projectId);
      if (!project) continue; // configured destinations are outside discovery
      if (project.teamIds.length <= 1) {
        if (binding.teamCandidates !== undefined) return false;
        if (binding.teamId !== (project.teamIds[0] ?? null) && binding.teamId !== null) return false;
      } else if (binding.teamId !== null && !project.teamIds.includes(binding.teamId)) return false;
    }
    return true;
  },
};
