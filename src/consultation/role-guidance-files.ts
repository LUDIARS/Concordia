/**
 * 役職フォルダの指示ファイルとスキル (`<名前>/SKILL.md`) を読み、 指示ファイルを自分で読めない
 * provider の相談の初回指示に載せるブロックにする (spec/feature/tech-consultation.md §6、 CC-CONSULT-INV-11)。
 *
 * 読み込み先は Codex と Claude Code の共有配置 (AGENTS.md と `.agents/skills`) を先に、 無いときだけ旧配置
 * (CLAUDE.md と `.claude/skills`) を読む (ROLE_GUIDANCE_INSTRUCTION_FILES / ROLE_GUIDANCE_SKILL_DIRS の順)。
 * 両方あるときは共有配置だけを読む (同じ内容を二重に載せない)。
 *
 * 読むのは役職フォルダ直下だけ。 相談者のデータフォルダ (`<役職>/<Discord ID>/`) や上位のフォルダは読まない
 * (CC-CONSULT-INV-08 と同じ範囲)。 読めないファイルはその分を載せずに起動を続ける (起動できないほうが困る)。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { contract } from "./ontime-runtime.js";
import readRoleGuidanceFilesContract from "./role-guidance-files.contract.js";
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
}

/** 役職フォルダの指示ファイル。 先に見つかった 1 つだけを読む (共有配置 → 旧配置)。 */
export const ROLE_GUIDANCE_INSTRUCTION_FILES: readonly string[] = Object.freeze(["AGENTS.md", "CLAUDE.md"]);

/** 役職フォルダのスキルの置き場所。 先に見つかったフォルダだけを読む (共有配置 → 旧配置)。 */
export const ROLE_GUIDANCE_SKILL_DIRS: readonly string[] = Object.freeze([".agents/skills", ".claude/skills"]);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** 役職フォルダの指示ファイルとスキルを読む。 無いファイルは黙って飛ばし、 読めないファイルは unreadable に返す。 */
export async function readRoleGuidanceFiles(roleDir: string): Promise<RoleGuidanceFilesResult> {
  const unreadable: string[] = [];
  // 無ければ undefined (次の読み込み先へ進む)、 読めなければ null (unreadable に記録する)。
  const read = async (relative: string): Promise<string | null | undefined> => {
    try {
      return await readFile(join(roleDir, relative), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      unreadable.push(relative);
      return null;
    }
  };

  let claudeMd: string | null = null;
  for (const file of ROLE_GUIDANCE_INSTRUCTION_FILES) {
    const text = await read(file);
    if (text === undefined) continue;
    claudeMd = text;
    break;
  }

  let skillDir: string | null = null;
  let skillNames: string[] = [];
  for (const dir of ROLE_GUIDANCE_SKILL_DIRS) {
    try {
      const entries = await readdir(join(roleDir, dir), { withFileTypes: true });
      skillDir = dir;
      skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) continue;
      unreadable.push(dir);
    }
    break;
  }
  const skills: RoleGuidanceSkill[] = [];
  for (const name of skillDir ? skillNames : []) {
    const text = await read(`${skillDir}/${name}/SKILL.md`);
    if (typeof text === "string") skills.push({ name, text });
  }
  return { source: { claudeMd, skills }, unreadable };
}
// @ts-expect-error contract wrap (observe only)
readRoleGuidanceFiles = contract(readRoleGuidanceFiles, { ...readRoleGuidanceFilesContract, contractId: "consult-guide-C-4", mode: "observe", sample: 1, where: "src/consultation/role-guidance-files.ts", rule: "contract-wrap", id: "consult-guide-C-4" });

/**
 * provider が指示ファイルを自分で読めなければ、 役職フォルダの指示を初回指示のブロックにして返す。
 * claude・載せるものが無いときは null。 本文はログに出さない。
 */
export async function loadInlineRoleGuidance(
  roleDir: string,
  provider: string,
  log: RoleGuidanceWarnLog,
): Promise<string | null> {
  if (!needsInlineRoleGuidance(provider)) return null;
  const { source, unreadable } = await readRoleGuidanceFiles(roleDir);
  if (unreadable.length > 0) {
    log.warn({ roleDir, unreadable }, "consult role guidance: some files could not be read; launching without them");
  }
  const block = buildRoleGuidanceBlock(source);
  if (block && block.omittedSkills.length > 0) {
    log.warn({ roleDir, omittedSkills: block.omittedSkills }, "consult role guidance exceeded the size limit; skills omitted");
  }
  return block?.text ?? null;
}
