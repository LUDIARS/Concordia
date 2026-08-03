// 委託 run のコミット代行を許すかどうかの判定 (純関数)。
// 拒否コードの一覧と意味は spec/feature/delegation.md §14 の表が単一情報源。
//
// なぜ要るか: Codex は `sandbox_mode = "workspace-write"` で走るため、 ワークスペース内の
// ファイルは書けるが `.git` は書けない (index.lock が Permission denied)。 結果として
// 「実装は済んでいるのにコミットできず run が failed」 という失敗が繰り返し起きる。
// そこで Concordia が代わりにコミットするが、 **run が所有する worktree の、 run が
// 宣言したブランチだけ** に限定しないと、 委託先の暴走がそのまま履歴に入る。
//
// この判定を Concordia に置けるのは、 run → cwd / branch の対応を知っているのが
// Concordia だけだから (dw は GitHub API クライアントで、 ローカル git は別ドメイン)。

import { resolve, sep } from "node:path";

/** 保護ブランチ。 ここへの直接コミットは代行しない。 */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master"];

/** 1 コミットで代行する変更ファイル数の上限。 超えたら人間に見せる。 */
export const MAX_CHANGED_FILES = 200;

export interface CommitGuardInput {
  /** run.spawn_cwd (= 委託先に渡した作業ディレクトリ) */
  runCwd: string | null;
  /** run.spawn_branch (= 委託先に渡したブランチ。 null なら現在ブランチを採用) */
  runBranch: string | null;
  /** `git rev-parse --show-toplevel` の結果 */
  repoRoot: string;
  /** `git rev-parse --abbrev-ref HEAD` の結果 */
  currentBranch: string;
  /** `git status --porcelain` で見えた変更パス */
  changedPaths: readonly string[];
  /**
   * コミット代行を禁止するディレクトリ (絶対パス)。 既定は呼び出し側が
   * ワークスペースルート (Castra) を渡す。 ワークスペースルート自体はリポジトリの
   * 集合であって作業対象ではないため、 ここへのコミットは常に誤り。
   */
  forbiddenRoots: readonly string[];
}

export type CommitGuardVerdict =
  | { ok: true }
  | { ok: false; code: CommitGuardRejection; detail: string };

export type CommitGuardRejection =
  | "run_cwd_unknown"
  | "cwd_outside_repo"
  | "forbidden_root"
  | "branch_mismatch"
  | "protected_branch"
  | "detached_head"
  | "nothing_to_commit"
  | "too_many_changes";

/** path 比較用の正規化。 Windows の大文字小文字差と末尾 sep を吸収する。 */
function normalizePath(input: string): string {
  const resolved = resolve(input);
  const trimmed = resolved.endsWith(sep) && resolved.length > 1
    ? resolved.slice(0, -sep.length)
    : resolved;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function isSameOrInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p + (process.platform === "win32" ? sep.toLowerCase() : sep));
}

/**
 * コミット代行の可否を判定する。 拒否理由は呼び出し側がそのまま API の
 * `code` として返せる形にしてある (無言で握りつぶさない)。
 */
export function checkCommitAllowed(input: CommitGuardInput): CommitGuardVerdict {
  if (!input.runCwd) {
    return {
      ok: false,
      code: "run_cwd_unknown",
      detail: "this run has no spawn_cwd, so there is no worktree it owns",
    };
  }

  if (!isSameOrInside(input.runCwd, input.repoRoot)) {
    return {
      ok: false,
      code: "cwd_outside_repo",
      detail: `run cwd ${input.runCwd} is not inside repo root ${input.repoRoot}`,
    };
  }

  for (const forbidden of input.forbiddenRoots) {
    if (normalizePath(input.repoRoot) === normalizePath(forbidden)) {
      return {
        ok: false,
        code: "forbidden_root",
        detail: `${input.repoRoot} is a workspace root, not a work target`,
      };
    }
  }

  if (input.currentBranch === "HEAD") {
    return { ok: false, code: "detached_head", detail: "HEAD is detached; refusing to commit" };
  }

  if (PROTECTED_BRANCHES.includes(input.currentBranch)) {
    return {
      ok: false,
      code: "protected_branch",
      detail: `${input.currentBranch} is protected; delegate work must land on a feature branch`,
    };
  }

  if (input.runBranch && input.runBranch !== input.currentBranch) {
    return {
      ok: false,
      code: "branch_mismatch",
      detail: `run was launched on ${input.runBranch} but the worktree is on ${input.currentBranch}`,
    };
  }

  if (input.changedPaths.length === 0) {
    return { ok: false, code: "nothing_to_commit", detail: "working tree is clean" };
  }

  if (input.changedPaths.length > MAX_CHANGED_FILES) {
    return {
      ok: false,
      code: "too_many_changes",
      detail: `${input.changedPaths.length} changed files exceeds the ${MAX_CHANGED_FILES} file cap`,
    };
  }

  return { ok: true };
}
