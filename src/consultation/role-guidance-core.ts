/** @implements SPEC-CONSULT-PROJECTLESS: pure role guidance schema and frontmatter normalization. */
/** Default limit in characters for carried role guidance. */
export const ROLE_GUIDANCE_MAX_CHARS = 40_000;

export interface RoleGuidanceSkill {
  name: string;
  /** SKILL.md の全文 (frontmatter 付きのままでよい)。 */
  text: string;
}

export interface RoleGuidanceSource {
  claudeMd: string | null;
  skills: readonly RoleGuidanceSkill[];
}

export interface RoleGuidanceBlockInput extends RoleGuidanceSource {
  maxChars?: number;
}

export interface RoleGuidanceBlock {
  text: string;
  /** 上限のために載せなかったスキル名 (呼び出し側が warn ログに出す)。 */
  omittedSkills: string[];
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Remove leading YAML frontmatter without entering public observation wrappers. */
export function stripSkillFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, "").trim();
}
