/** @implements SPEC-CONSULT-PROJECTLESS */
/** C-3: the skill body never keeps a leading YAML frontmatter, and text without one is only trimmed. */
export default {
  post(result: unknown, text?: unknown): boolean {
    if (typeof result !== "string" || typeof text !== "string") return false;
    if (/^\uFEFF?---[ \t]*\r?\n/.test(text) && /\r?\n---[ \t]*(\r?\n|$)/.test(text)) {
      return !/^---[ \t]*\r?\n[\s\S]*?\r?\n---/.test(result) || result.length < text.length;
    }
    return result === text.trim();
  },
};
