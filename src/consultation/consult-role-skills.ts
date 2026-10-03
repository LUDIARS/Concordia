/**
 * 役職フォルダのスキルを Claude と codex で共通にする (spec/feature/tech-consultation.md §6、 2026-10-03 neco 指示
 * 「Claude も AGENT.md を見るようになったはずなので、 いまは設定を共通化できるはず」)。
 *
 * スキルの正本は役職フォルダの `.agents/skills` (codex が cwd から探す場所)。 Claude Code は `.agents/` を読まないので、
 * フォルダの準備時に `.claude/skills` をそこへの junction で張る (張れなければコピー)。 既に `.claude/skills` がある
 * フォルダ (移行前のもの) は触らない — 人が `.agents/skills` へ移してから消す (自動で移さない)。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { cp, lstat, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:ad162019 */
import augurContract_56ea456b from './consult-role-skills.contract.js'; /* augur-inject:contract-predicate:7cf23ae2 */

export type RoleSkillsLinkPlan = "link" | "keep-existing" | "nothing";

/** `.claude/skills` を `.agents/skills` へつなぐか。 */
export function planRoleSkillsLink(state: { agentsSkills: boolean; claudeSkills: boolean }): RoleSkillsLinkPlan {
  if (state.claudeSkills) return "keep-existing";
  return state.agentsSkills ? "link" : "nothing";
}
// @ts-expect-error augur-inject
planRoleSkillsLink = contract(planRoleSkillsLink, { ...augurContract_56ea456b, contractId: 'consult-skills-C-4', mode: 'observe', sample: 1, where: 'src/consultation/consult-role-skills.ts:18', rule: 'contract-wrap', id: '56ea456b' }); /* augur-inject:contract-wrap:56ea456b */

export interface RoleSkillsFs {
  exists(path: string): Promise<boolean>;
  /** ディレクトリの junction (Windows) / symlink を張る。 */
  link(target: string, path: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
}

const nodeFs: RoleSkillsFs = {
  // 壊れた junction も「ある」と見る (lstat)。 張り直しで上書きしない。
  exists: (path) => lstat(path).then(() => true, () => false),
  link: async (target, path) => {
    await mkdir(dirname(path), { recursive: true });
    await symlink(target, path, "junction");
  },
  copy: async (source, destination) => {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  },
};

/** 役職フォルダの `.claude/skills` を `.agents/skills` へつなぐ。 何をしたかを返す。 */
export async function linkRoleSkills(
  roleDir: string,
  fs: RoleSkillsFs = nodeFs,
): Promise<"linked" | "copied" | "kept-existing" | "nothing"> {
  const agents = join(roleDir, ".agents", "skills");
  const claude = join(roleDir, ".claude", "skills");
  const plan = planRoleSkillsLink({ agentsSkills: await fs.exists(agents), claudeSkills: await fs.exists(claude) });
  if (plan === "keep-existing") return "kept-existing";
  if (plan === "nothing") return "nothing";
  try {
    await fs.link(agents, claude);
    return "linked";
  } catch {
    // junction を張れない環境 (権限・ファイルシステム) ではコピーで代える。 正本は .agents/skills のまま。
    await fs.copy(agents, claude);
    return "copied";
  }
}
