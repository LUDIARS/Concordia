/** @implements SPEC-CONSULT-PROJECTLESS */
/**
 * C-4: the role guidance is read from one location only — skill names never repeat (the shared and legacy skill
 * folders are not merged) and every unreadable path lies under a known guidance location.
 */
const LOCATIONS = ["AGENTS.md", "CLAUDE.md", ".agents/skills", ".claude/skills"];

export default {
  post(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const { source, unreadable } = result as { source?: { skills?: Array<{ name?: unknown }> }; unreadable?: unknown };
    if (!Array.isArray(source?.skills) || !Array.isArray(unreadable)) return false;
    const names = source.skills.map((skill) => skill.name);
    if (new Set(names).size !== names.length) return false;
    return unreadable.every((path) => typeof path === "string"
      && LOCATIONS.some((location) => path === location || path.startsWith(`${location}/`)));
  },
};
