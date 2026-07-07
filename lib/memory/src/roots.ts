/**
 * 走査 roots の解決 (fail-fast)。
 *
 * - arsDir: LUDIARS 全リポと グローバルスキル `.claude/skills` を含む親
 *   (既定はプライマリ workspace root、 env `CONCORDIA_ARS_DIR` で上書き)。
 * - claudeProjectsDir: `~/.claude/projects` (メモリ home 群の親、
 *   env `CONCORDIA_CLAUDE_PROJECTS_DIR` で上書き)。
 * - centralSlug: 主ワークスペースのメモリ home slug (env `CONCORDIA_CENTRAL_MEMORY_SLUG`)。
 *
 * 必須前提 (両 base dir のどちらかは実在) が満たせなければ silent に空で返さず
 * 例外を投げる (規約 §6/§7.1 fail-fast)。
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LibraryRoots {
  arsDir: string;
  claudeProjectsDir: string;
  centralSlug: string;
}

export class LibraryRootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryRootsError";
  }
}

const DEFAULT_CENTRAL_SLUG = "E--Document-Ars";

export function resolveLibraryRoots(workspaceRoots: string[]): LibraryRoots {
  const envArs = (process.env.CONCORDIA_ARS_DIR ?? "").trim();
  const arsDir = envArs || workspaceRoots.find((r) => r && r.trim()) || "";

  const envProjects = (process.env.CONCORDIA_CLAUDE_PROJECTS_DIR ?? "").trim();
  const claudeProjectsDir = envProjects || join(homedir(), ".claude", "projects");

  const centralSlug =
    (process.env.CONCORDIA_CENTRAL_MEMORY_SLUG ?? "").trim() || DEFAULT_CENTRAL_SLUG;

  const arsOk = arsDir !== "" && existsSync(arsDir);
  const projectsOk = existsSync(claudeProjectsDir);
  if (!arsOk && !projectsOk) {
    throw new LibraryRootsError(
      `走査 roots を解決できません: arsDir=${arsDir || "(未設定)"} / ` +
        `claudeProjectsDir=${claudeProjectsDir} のいずれも存在しません。 ` +
        `workspace root 設定か CONCORDIA_ARS_DIR / CONCORDIA_CLAUDE_PROJECTS_DIR を確認してください。`,
    );
  }

  return { arsDir, claudeProjectsDir, centralSlug };
}
