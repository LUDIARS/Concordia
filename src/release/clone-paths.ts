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

/**
 * workspace root からの traversal や絶対パス化を防ぐ単一ディレクトリ名か。
 *
 * `resolveClonePaths` はリポ名を `join(root, repoName)` のパス片として使うので、
 * リポ名が外部由来 (通知本文・API 入力・catalog) のときは必ずこれを通してから渡す。
 * `..` や `C:` を素通しすると workspace 外のディレクトリを本体クローンとみなし、
 * そこで build / 再起動を走らせてしまう。
 */
export function isSafeRepoName(value: string): boolean {
  return value.length > 0
    && value.length <= 200
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes(":")
    && !value.includes("\0");
}

/**
 * `owner/repo` ないし `repo` の全区間がパス片として安全か。
 *
 * `repoNameFromOrigin` は末尾だけを取るので、 その戻り値を `isSafeRepoName` にかけても
 * `C:/Windows` や `../Concordia` のように **危険な前半 + 安全な末尾**の組み合わせは
 * 素通ししてしまう。 分割前の文字列を扱うときはこちらを使う。
 */
export function isSafeRepoOrigin(value: string): boolean {
  const parts = value.split("/");
  return parts.length <= 2 && parts.every((part) => isSafeRepoName(part));
}
