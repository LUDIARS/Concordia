/** @implements SPEC-CONSULT-PROJECTLESS */
/**
 * C-3: the consult CODEX_HOME config.toml disables every user skill it was given (one skills.config entry with
 * enabled = false per SKILL.md) and stops the ancestor walk for AGENTS.md (project_root_markers = []).
 */
export default {
  post(result: unknown, userSkillFiles?: unknown): boolean {
    if (typeof result !== "string" || !Array.isArray(userSkillFiles)) return false;
    if (!/^project_root_markers = \[\]$/m.test(result)) return false;
    const entries = result.split("[[skills.config]]").slice(1);
    if (entries.length !== userSkillFiles.length) return false;
    return userSkillFiles.every((file) => entries.some((entry) =>
      entry.includes(`path = ${JSON.stringify(String(file).replace(/\\/g, "/"))}`) && /enabled = false/.test(entry)));
  },
};
