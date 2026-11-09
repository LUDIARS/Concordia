/**
 * 文章 (タイトル・current_task・branch) から作業対象 (target_project) を推定してよいかの判断。
 *
 * 推定は、ワークスペースルート (umbrella) で起動したセッションが「いまどの個別プロジェクトを
 * 扱っているか」を補うためのもの。特定のリポジトリ (linked worktree を含む) を cwd にした
 * セッションは、そのリポジトリが作業対象であり、文章に別プロジェクト名が出ても上書きしない。
 *
 * 例: 委託の子セッションは「Actio タスク参照」から作業を始めるため、current_task に「Actio」が
 * 出る。これを作業対象と取り違えると、Actio タスク本文を Actio の binding で読みに行き
 * actio_scope_denied になる (actio:fbe1a347-f1a6-4738-9fac-de0ac4fe77e1)。
 */
import { isWorkspaceRootCwd } from "./session-work-policy.js";

export function mayInferTargetProjectFromText(
  repoPath: string | null | undefined,
  workspaceRoots: readonly string[],
): boolean {
  const cwd = repoPath?.trim() ?? "";
  if (!cwd) return true;
  return isWorkspaceRootCwd(cwd, workspaceRoots);
}
