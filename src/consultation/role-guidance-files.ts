/**
 * 役職フォルダの指示ファイル (CLAUDE.md と `.claude/skills/<名前>/SKILL.md`) を読み、 指示ファイルを自分で読めない
 * provider の相談の初回指示に載せるブロックにする (spec/feature/tech-consultation.md §6、 CC-CONSULT-INV-11)。
 *
 * 読むのは役職フォルダ直下の 2 か所だけ。 相談者のデータフォルダ (`<役職>/<Discord ID>/`) や上位のフォルダは読まない
 * (CC-CONSULT-INV-08 と同じ範囲)。 読めないファイルはその分を載せずに起動を続ける (起動できないほうが困る)。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { readdir, readFile } from "node:fs/promises";
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
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** 役職フォルダの CLAUDE.md とスキルを読む。 無いファイルは黙って飛ばし、 読めないファイルは unreadable に返す。 */
export async function readRoleGuidanceFiles(roleDir: string): Promise<RoleGuidanceFilesResult> {
  const unreadable: string[] = [];
  const read = async (relative: string): Promise<string | null> => {
    try {
      return await readFile(join(roleDir, relative), "utf8");
    } catch (error) {
      if (!isMissing(error)) unreadable.push(relative);
      return null;
    }
  };
  const claudeMd = await read("CLAUDE.md");
  let skillNames: string[] = [];
  try {
    const entries = await readdir(join(roleDir, ".claude", "skills"), { withFileTypes: true });
    skillNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (!isMissing(error)) unreadable.push(".claude/skills");
  }
  const skills: RoleGuidanceSkill[] = [];
  for (const name of skillNames) {
    const text = await read(`.claude/skills/${name}/SKILL.md`);
    if (text !== null) skills.push({ name, text });
  }
  return { source: { claudeMd, skills }, unreadable };
}

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
