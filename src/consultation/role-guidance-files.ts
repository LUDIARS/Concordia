/**
 * 役職フォルダの指示のうち、 指示ファイルを自分で読めない provider (Astra / codex) が読めない分を読み、 相談の初回指示に
 * 載せるブロックにする (spec/feature/tech-consultation.md §6、 CC-CONSULT-INV-11)。
 *
 * 役職フォルダの指示は AGENTS.md 1 本 (Claude も codex も自分で読む) で、 スキルの正本は `.agents/skills`
 * (2026-10-03 neco 指示「いまは設定を共通化できるはず」)。 codex は AGENTS.md を自分で読むので載せない (二重に読ませない)。
 * スキルは、 相談の codex がシェルを持たず SKILL.md を開けないため、 本文を載せる。
 * 移行前の役職フォルダ (AGENTS.md が無く CLAUDE.md がある・スキルが `.claude/skills` にある) は、 codex が読めないので
 * CLAUDE.md と `.claude/skills` を載せ、 AGENTS.md / `.agents/skills` へ移す案内を warn ログに出す。
 *
 * 読むのは役職フォルダ直下だけ。 相談者のデータフォルダ (`<役職>/<Discord ID>/`) や上位のフォルダは読まない
 * (CC-CONSULT-INV-08 と同じ範囲)。 読めないファイルはその分を載せずに起動を続ける (起動できないほうが困る)。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRoleGuidanceBlock,
  needsInlineRoleGuidance,
  type RoleGuidanceSkill,
  type RoleGuidanceSource,
} from "./role-guidance.js";

export interface RoleGuidanceWarnLog {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface RoleGuidanceFilesResult {
  source: RoleGuidanceSource;
  /** 読めなかったファイル (役職フォルダからの相対パス)。 */
  unreadable: string[];
  /** 移行前の置き方で読んだもの (AGENTS.md / .agents/skills へ移す案内に使う)。 */
  legacy: string[];
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

const isDirectory = (path: string): Promise<boolean> => stat(path).then((s) => s.isDirectory(), () => false);

/**
 * 役職フォルダの指示のうち codex が自分で読めない分 (移行前の CLAUDE.md とスキル) を読む。
 * 無いファイルは黙って飛ばし、 読めないファイルは unreadable に返す。
 */
export async function readRoleGuidanceFiles(roleDir: string): Promise<RoleGuidanceFilesResult> {
  const unreadable: string[] = [];
  const legacy: string[] = [];
  const read = async (relative: string): Promise<string | null> => {
    try {
      return await readFile(join(roleDir, relative), "utf8");
    } catch (error) {
      if (!isMissing(error)) unreadable.push(relative);
      return null;
    }
  };
  // AGENTS.md は codex が自分で読む。 無いときだけ移行前の CLAUDE.md を載せる。
  let claudeMd: string | null = null;
  if ((await read("AGENTS.md")) === null) {
    claudeMd = await read("CLAUDE.md");
    if (claudeMd !== null) legacy.push("CLAUDE.md");
  }
  const skillsDir = (await isDirectory(join(roleDir, ".agents", "skills"))) ? ".agents/skills" : ".claude/skills";
  let skillNames: string[] = [];
  try {
    const entries = await readdir(join(roleDir, ...skillsDir.split("/")), { withFileTypes: true });
    skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (!isMissing(error)) unreadable.push(skillsDir);
  }
  const skills: RoleGuidanceSkill[] = [];
  for (const name of skillNames) {
    const text = await read(`${skillsDir}/${name}/SKILL.md`);
    if (text !== null) skills.push({ name, text });
  }
  if (skillsDir === ".claude/skills" && skills.length > 0) legacy.push(".claude/skills");
  return { source: { claudeMd, skills }, unreadable, legacy };
}

/**
 * provider が指示ファイルを自分で読めなければ、 読めない分を初回指示のブロックにして返す。
 * claude・載せるものが無いときは null。 本文はログに出さない。
 */
export async function loadInlineRoleGuidance(
  roleDir: string,
  provider: string,
  log: RoleGuidanceWarnLog,
): Promise<string | null> {
  if (!needsInlineRoleGuidance(provider)) return null;
  const { source, unreadable, legacy } = await readRoleGuidanceFiles(roleDir);
  if (unreadable.length > 0) {
    log.warn({ roleDir, unreadable }, "consult role guidance: some files could not be read; launching without them");
  }
  if (legacy.length > 0) {
    log.warn({ roleDir, legacy }, "consult role folder uses the pre-AGENTS.md layout; move CLAUDE.md to AGENTS.md and .claude/skills to .agents/skills");
  }
  const block = buildRoleGuidanceBlock(source);
  if (block && block.omittedSkills.length > 0) {
    log.warn({ roleDir, omittedSkills: block.omittedSkills }, "consult role guidance exceeded the size limit; skills omitted");
  }
  return block?.text ?? null;
}
