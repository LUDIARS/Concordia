import { ROLE_GUIDANCE_MAX_CHARS, stripSkillFrontmatter, type RoleGuidanceBlockInput } from "./role-guidance-core.js";

/** @implements SPEC-CONSULT-PROJECTLESS */
/**
 * C-2: the block is null when there is nothing to carry; otherwise it starts with the heading, carries every skill
 * body whole (never cut midway), drops whole skills only when over the limit, and names each dropped skill.
 */
export default {
  post(result: unknown, input?: RoleGuidanceBlockInput): boolean {
    if (!input) return false;
    const skills = input.skills
      .map((skill) => ({ name: skill.name, body: stripSkillFrontmatter(skill.text) }))
      .filter((skill) => skill.body.length > 0);
    const hasContent = Boolean(input.claudeMd?.trim()) || skills.length > 0;
    if (result === null) return !hasContent;
    if (!hasContent || typeof result !== "object") return false;
    const { text, omittedSkills } = result as { text: string; omittedSkills: string[] };
    if (!text.startsWith("## 相談窓口の前提と手順")) return false;
    const maxChars = input.maxChars ?? ROLE_GUIDANCE_MAX_CHARS;
    return skills.every((skill) => {
      const included = text.includes(`### 手順: ${skill.name}\n\n${skill.body}`);
      const omitted = omittedSkills.includes(skill.name);
      return included !== omitted;
    }) && (omittedSkills.length === 0 || text.length <= maxChars || omittedSkills.length === skills.length);
  },
};
