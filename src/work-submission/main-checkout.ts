// linked worktree から本体 checkout を解く (Git のメタデータだけを読む)。
// 経路の判定はプロジェクト登録 (本体の repo_path) と照合するため、worktree のパスのままだと
// 登録済みプロジェクトが「未登録」に落ちる (spec/feature/work-submission.md §3)。

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** worktree なら本体 checkout のパス、そうでなければ与えたパスをそのまま返す。読めなければ与えたパス。 */
export async function mainCheckoutPath(repoPath: string): Promise<string> {
  try {
    const marker = await readFile(join(repoPath, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(marker)?.[1]?.trim();
    if (!gitdir) return repoPath;
    const metadata = resolve(repoPath, gitdir);
    const common = (await readFile(join(metadata, "commondir"), "utf8")).trim();
    return dirname(resolve(metadata, common));
  } catch {
    // .git がディレクトリ (本体 checkout) / 存在しない / commondir が無い → 解けないので与えたパスで照合する。
    return repoPath;
  }
}
