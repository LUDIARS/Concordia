import { ROLE_GUIDANCE_MAX_CHARS, stripSkillFrontmatter as stripFrontmatterCore, type RoleGuidanceBlockInput, type RoleGuidanceBlock } from "./role-guidance-core.js";
export { ROLE_GUIDANCE_MAX_CHARS, type RoleGuidanceSkill, type RoleGuidanceSource, type RoleGuidanceBlockInput, type RoleGuidanceBlock } from "./role-guidance-core.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:37000b15 */
import augurContract_9a0c2082 from './role-guidance-provider.contract.js'; /* augur-inject:contract-predicate:1199e4e5 */
import augurContract_2871634a from './role-guidance-block.contract.js'; /* augur-inject:contract-predicate:368ad07c */
import augurContract_98a8198e from './role-guidance-frontmatter.contract.js'; /* augur-inject:contract-predicate:5dec70d3 */
/**
 * 指示ファイルを自分で読めない provider の相談に、 役職フォルダの指示のうち読めない分を初回指示として載せる
 * (spec/feature/tech-consultation.md §6、 2026-10-02 neco 指示「役職は spawn 前に決定するので読み分けで良い」)。
 *
 * claude は役職フォルダの AGENTS.md (CLAUDE.md が無いとき) と `.claude/skills` を自分で読む。 Astra (codex) は
 * AGENTS.md を自分で読むが、 閉じ込めの引数 (`--disable shell_tool`) のために SKILL.md を開けないので、 Cc が読んだ
 * スキル本文 (と移行前の CLAUDE.md) をここでブロックにする。 何を読むかは呼び出し側 (role-guidance-files.ts)。
 *
 * - CC-CONSULT-INV-11: 相談セッションは provider に関わらず役職フォルダの指示を受け取る。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

/** 指示ファイルを自分で読めない provider か。 claude は役職フォルダの CLAUDE.md とスキルを自分で読む。 */
export function needsInlineRoleGuidance(provider: string): boolean {
  return provider !== "claude";
}
// @ts-expect-error augur-inject
needsInlineRoleGuidance = contract(needsInlineRoleGuidance, { ...augurContract_9a0c2082, contractId: 'consult-guide-C-1', mode: 'observe', sample: 1, where: 'src/consultation/role-guidance.ts:39', rule: 'contract-wrap', id: '9a0c2082' }); /* augur-inject:contract-wrap:9a0c2082 */

/** SKILL.md 先頭の YAML frontmatter を外した本文。 frontmatter が無ければそのまま。 */
export function stripSkillFrontmatter(text: string): string {
  return stripFrontmatterCore(text);
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
