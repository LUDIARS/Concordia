/**
 * base..branch のコミット件名を読む (local PR のタイトル / 本文用)。
 *
 * 読み取り専用の git 呼び出しのみ。 タイムアウトと件数上限を持ち、 巨大なブランチや
 * 応答しない git でセッション終了処理を止めない。
 *
 * spec/feature/revisor-local-pr-submission.md §7。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const GIT_TIMEOUT_MS = 5_000;
/** タイトル / 本文に使うだけなので、 これ以上は読まない。 */
const MAX_COMMITS = 50;

/**
 * ref として git に渡してよい文字列か。 base ref は Revisor の登録値、 branch は
 * hook が登録したセッション値で、 どちらもこの関数から見れば外部入力。 先頭 `-` は
 * git がオプションとして解釈するため弾く (`--output=...` 等の混入防止)。
 */
function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-") && !/[\s~^:?*[\\]/.test(ref);
}

export async function listBranchCommits(
  repoPath: string,
  baseRef: string,
  branch: string,
): Promise<string[]> {
  if (!isSafeRef(baseRef) || !isSafeRef(branch)) {
    throw new Error(`unsafe git ref: ${JSON.stringify({ baseRef, branch })}`);
  }
  // `base..branch` は「branch にだけあるコミット」。 base が進んでいても差分は増えない。
  const { stdout } = await execFileAsync(
    GIT_BIN,
    [
      "-C",
      repoPath,
      "log",
      "--no-merges",
      `--max-count=${MAX_COMMITS}`,
      "--pretty=format:%s",
      `${baseRef}..${branch}`,
      // 末尾の `--` で「これは revision であってパスではない」と確定させる。
      // 同名のファイル/ディレクトリがあるリポジトリで ambiguous argument にならない。
      "--",
    ],
    { timeout: GIT_TIMEOUT_MS, windowsHide: true },
  );
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
