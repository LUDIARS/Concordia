/**
 * main 系 / develop 系クローンのパス解決。
 *
 *   main 系:    <workspaceRoot>/<Repo>
 *   develop 系: <workspaceRoot>/develop/<Repo>
 *
 * develop 系を `<Repo>-develop` のような兄弟ディレクトリにすると、 ワークスペース直下の
 * `.git` 持ちディレクトリをリポとみなす既存の走査 (Work ページ / ludiars-review /
 * ludiars-status) が全リポを二重に拾ってしまう。 `develop/` 配下なら `develop/` 自身が
 * `.git` を持たないので走査対象外になる。
 *
 * spec/feature/develop-confirm-flow.md §1。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** develop クローンを収めるサブディレクトリ名。 */
export const DEVELOP_DIR = "develop";

export interface ClonePaths {
  /** main 系クローン (従来の作業クローン)。 存在しなければ null。 */
  main: string | null;
  /** develop 系クローン。 まだ用意されていなければ null。 */
  develop: string | null;
}

/**
 * リポ名から main / develop クローンのパスを引く。 複数ワークスペースルートがある場合は
 * 先に見つかったものを採る (走査と同じ優先順)。
 */
export function resolveClonePaths(repoName: string, workspaceRoots: string[]): ClonePaths {
  let main: string | null = null;
  let develop: string | null = null;
  for (const root of workspaceRoots) {
    if (!main) {
      const candidate = join(root, repoName);
      if (existsSync(join(candidate, ".git"))) main = candidate;
    }
    if (!develop) {
      const candidate = join(root, DEVELOP_DIR, repoName);
      if (existsSync(join(candidate, ".git"))) develop = candidate;
    }
    if (main && develop) break;
  }
  return { main, develop };
}

/** `owner/repo` からローカルのディレクトリ名 (= repo 部分) を取る。 */
export function repoNameFromOrigin(repoOrigin: string): string {
  const parts = repoOrigin.split("/");
  return parts[parts.length - 1] ?? repoOrigin;
}
