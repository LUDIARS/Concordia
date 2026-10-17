/**
 * 役職の指示ブロックの入力型・上限・SKILL.md 本文の取り出し (spec/feature/tech-consultation.md §6)。
 *
 * `role-guidance.ts` (ブロックの組み立て) と、 その契約述語 `role-guidance-block.contract.ts` が共有する。
 * `role-guidance.ts` に置くと、 契約を読み込む `role-guidance.ts` と述語が互いを import する循環になるので
 * ここへ分ける。 公開名は `role-guidance.ts` からも再エクスポートする。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

/** 初回指示に載せる役職の指示の既定の上限 (文字数)。 */
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

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** SKILL.md 先頭の YAML frontmatter を外した本文 (契約で包まない素の実装)。 */
export function removeSkillFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, "").trim();
}
