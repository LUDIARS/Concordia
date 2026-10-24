/** @implements CC-TASK-LINKED-FOLLOWUP — actio-link-C-1 参照範囲は project・owner・team で決める */
/** C-1: accepted only when project and owner match the binding and the team is null or within the binding. */
export default {
  post(result: unknown, binding: unknown, task: unknown): boolean {
    if (result !== true) return true;
    const b = binding as { projectId?: unknown; ownerId?: unknown; teamId?: unknown; teamCandidates?: unknown } | null;
    const t = task as { projectId?: unknown; ownerId?: unknown; teamId?: unknown } | null;
    if (!b || !t || t.projectId !== b.projectId || t.ownerId !== b.ownerId) return false;
    if (t.teamId === null || t.teamId === b.teamId) return true;
    return b.teamId === null && Array.isArray(b.teamCandidates) && b.teamCandidates.includes(t.teamId);
  },
};
