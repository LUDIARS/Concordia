/** @implements SPEC-CONSULT-PROJECTLESS */
/**
 * C-4: the role folder's .claude/skills is linked to .agents/skills only when .agents/skills exists and
 * .claude/skills does not; an existing .claude/skills is never touched.
 */
export default {
  post(result: unknown, state?: unknown): boolean {
    if (!state || typeof state !== "object") return false;
    const { agentsSkills, claudeSkills } = state as { agentsSkills?: unknown; claudeSkills?: unknown };
    if (claudeSkills === true) return result === "keep-existing";
    if (agentsSkills !== true) return result === "nothing";
    return result === "link";
  },
};
