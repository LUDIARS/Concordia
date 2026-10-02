import { contract } from './ontime-runtime.js'; /* augur-inject:import:37000b15 */
import augurContract_9a0c2082 from './role-guidance-provider.contract.js'; /* augur-inject:contract-predicate:1199e4e5 */
import augurContract_2871634a from './role-guidance-block.contract.js'; /* augur-inject:contract-predicate:368ad07c */
import augurContract_98a8198e from './role-guidance-frontmatter.contract.js'; /* augur-inject:contract-predicate:5dec70d3 */
/**
 * 指示ファイルを自分で読めない provider の相談に、 役職フォルダの指示 (CLAUDE.md とスキル) を初回指示として載せる
 * (spec/feature/tech-consultation.md §6、 2026-10-02 neco 指示「役職は spawn 前に決定するので読み分けで良い」)。
 *
 * claude は役職フォルダの CLAUDE.md と `.claude/skills` を自分で読む。 Astra (codex) は閉じ込めの引数
 * (`--disable shell_tool` / `-c project_doc_max_bytes=0` / `--disable plugins`) のためにどちらも読めないので、
 * Cc が読んだ本文をここでブロックにする。 ファイルを読むのは呼び出し側 (role-guidance-files.ts)。
 *
 * - CC-CONSULT-INV-11: 相談セッションは provider に関わらず役職フォルダの指示を受け取る。
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

export interface RoleGuidanceBlock {
  text: string;
  /** 上限のために載せなかったスキル名 (呼び出し側が warn ログに出す)。 */
  omittedSkills: string[];
}

/** 指示ファイルを自分で読めない provider か。 claude は役職フォルダの CLAUDE.md とスキルを自分で読む。 */
export function needsInlineRoleGuidance(provider: string): boolean {
  return provider !== "claude";
}
// @ts-expect-error augur-inject
needsInlineRoleGuidance = contract(needsInlineRoleGuidance, { ...augurContract_9a0c2082, contractId: 'consult-guide-C-1', mode: 'observe', sample: 1, where: 'src/consultation/role-guidance.ts:39', rule: 'contract-wrap', id: '9a0c2082' }); /* augur-inject:contract-wrap:9a0c2082 */

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** SKILL.md 先頭の YAML frontmatter を外した本文。 frontmatter が無ければそのまま。 */
export function stripSkillFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, "").trim();
}
// @ts-expect-error augur-inject
stripSkillFrontmatter = contract(stripSkillFrontmatter, { ...augurContract_98a8198e, contractId: 'consult-guide-C-3', mode: 'observe', sample: 1, where: 'src/consultation/role-guidance.ts:46', rule: 'contract-wrap', id: '98a8198e' }); /* augur-inject:contract-wrap:98a8198e */

const HEADING = "## 相談窓口の前提と手順";
const NO_SKILL_NOTE = "このセッションではスキルを呼び出せません。『〜を読んでください』とある手順は、下に全文を載せています。";

/**
 * 初回指示に載せるブロック。 載せるものが無ければ null。
 * 上限を超えるときはスキル単位で後ろから載せるのをやめる (途中で切った本文は載せない)。
 */
export function buildRoleGuidanceBlock(input: RoleGuidanceBlockInput): RoleGuidanceBlock | null {
  const maxChars = input.maxChars ?? ROLE_GUIDANCE_MAX_CHARS;
  const claudeMd = input.claudeMd?.trim() ?? "";
  const skills = [...input.skills]
    .map((skill) => ({ name: skill.name, body: stripSkillFrontmatter(skill.text) }))
    .filter((skill) => skill.body.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!claudeMd && skills.length === 0) return null;
  const head = [HEADING, NO_SKILL_NOTE, ...(claudeMd ? [claudeMd] : [])];
  const sections = skills.map((skill) => `### 手順: ${skill.name}\n\n${skill.body}`);
  const omittedSkills: string[] = [];
  const render = (count: number) => [...head, ...sections.slice(0, count)].join("\n\n");
  let count = sections.length;
  while (count > 0 && render(count).length > maxChars) {
    count -= 1;
    omittedSkills.unshift(skills[count]!.name);
  }
  return { text: render(count), omittedSkills };
}
// @ts-expect-error augur-inject
buildRoleGuidanceBlock = contract(buildRoleGuidanceBlock, { ...augurContract_2871634a, contractId: 'consult-guide-C-2', mode: 'observe', sample: 1, where: 'src/consultation/role-guidance.ts:57', rule: 'contract-wrap', id: '2871634a' }); /* augur-inject:contract-wrap:2871634a */
