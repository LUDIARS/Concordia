/**
 * @implements spec/feature/delegation-spawn-target-validation.md §2.6 — worktree の置き場所
 *
 * 本体 checkout (デプロイ先) と作業用 worktree を別ドライブに分けるための設定。
 * `CONCORDIA_WORKTREE_ROOT` が空なら従来どおり本体の隣 (`dirname(repoRoot)`) に作る。
 */
import { dirname } from "node:path";

export const WORKTREE_ROOT_ENV = "CONCORDIA_WORKTREE_ROOT";

/** 設定された worktree 置き場。未設定なら null。 */
export function configuredWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[WORKTREE_ROOT_ENV]?.trim().replace(/[\\/]+$/, "");
  return value ? value : null;
}

/** `repoRoot` の worktree を作る親ディレクトリ。 */
export function worktreeBaseDirFor(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return configuredWorktreeRoot(env) ?? dirname(repoRoot);
}
