/**
 * confirm フローが使う git 操作 (副作用の集約点)。
 *
 * ここ以外で clone を書き換えない。 特に **main 系クローンのブランチを勝手に切り替えない**
 * (他セッションが同じクローンで作業している)。 main 反映は ff-only でしか行わない。
 *
 * spec/feature/develop-confirm-flow.md §7。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

export interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return { ok: true, stdout: stdout.trim() };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, stdout: "", error: (err.stderr || err.message || "git failed").trim() };
  }
}

/** 作業ツリーに未コミットの変更があるか (あれば破壊的操作をしない)。 */
export async function isDirty(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["status", "--porcelain"]);
  return r.ok && r.stdout.length > 0;
}

/**
 * develop クローンを origin/develop に合わせる。 未コミットの変更があれば **何もせず失敗**を返す
 * (人間が試しに書いたものを消さない)。
 */
export async function syncDevelopClone(cwd: string): Promise<GitResult> {
  if (await isDirty(cwd)) {
    return { ok: false, stdout: "", error: "develop クローンに未コミットの変更があります (自動同期を中止しました)" };
  }
  const fetched = await git(cwd, ["fetch", "origin", "develop"]);
  if (!fetched.ok) return fetched;
  const checkout = await git(cwd, ["checkout", "develop"]);
  if (!checkout.ok) return checkout;
  const reset = await git(cwd, ["reset", "--hard", "origin/develop"]);
  if (!reset.ok) return reset;
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * develop を main に反映する。 **ff-only** — main が develop から分岐していたら失敗させ、
 * 人間に返す (勝手に merge commit を作らない。 main への直接 hotfix はここで検出できる)。
 *
 * main 系クローンの HEAD は触らず、 リモート参照だけで push する。
 */
export async function promoteDevelopToMain(cwd: string, approvedDevelopSha: string): Promise<GitResult> {
  if (!/^[0-9a-f]{40}$/i.test(approvedDevelopSha)) {
    return { ok: false, stdout: "", error: "承認済み develop SHA が不正です" };
  }
  const fetched = await git(cwd, ["fetch", "origin", "main", "develop"]);
  if (!fetched.ok) return fetched;

  const actualDevelop = await git(cwd, ["rev-parse", "origin/develop"]);
  if (!actualDevelop.ok) return actualDevelop;
  if (actualDevelop.stdout.toLowerCase() !== approvedDevelopSha.toLowerCase()) {
    return {
      ok: false,
      stdout: "",
      error: `develop HEAD が確認開始時から変わりました (approved=${approvedDevelopSha.slice(0, 12)}, current=${actualDevelop.stdout.slice(0, 12)})`,
    };
  }

  const expectedMain = await git(cwd, ["rev-parse", "origin/main"]);
  if (!expectedMain.ok) return expectedMain;

  // origin/main が origin/develop の祖先か (= ff できるか) を先に判定する。
  const ancestor = await git(cwd, ["merge-base", "--is-ancestor", expectedMain.stdout, approvedDevelopSha]);
  if (!ancestor.ok) {
    return {
      ok: false,
      stdout: "",
      error: "main が develop から分岐しています (ff できません)。 main に直接入った変更が無いか確認してください",
    };
  }
  // ローカルの作業ツリーを一切動かさず、 リモート参照どうしで push する。
  // Compare-and-swap: main が fetch 後に動いていたら force-with-lease が拒否する。
  // push する object も approvedDevelopSha そのものに固定し、動く branch ref を使わない。
  const pushed = await git(cwd, [
    "push",
    `--force-with-lease=refs/heads/main:${expectedMain.stdout}`,
    "origin",
    `${approvedDevelopSha}:refs/heads/main`,
  ]);
  if (!pushed.ok) return pushed;
  return { ok: true, stdout: approvedDevelopSha };
}

/**
 * main 系クローンを origin/main に追従させる。 未コミットの変更があれば fetch だけして
 * reset はしない (他セッションの作業を壊さない)。 その場合も ok=false ではなく警告を返す。
 */
export async function syncMainClone(cwd: string): Promise<GitResult> {
  const fetched = await git(cwd, ["fetch", "origin", "main"]);
  if (!fetched.ok) return fetched;
  if (await isDirty(cwd)) {
    return { ok: false, stdout: "", error: "main クローンに未コミットの変更があるため reset を見送りました (手動で同期してください)" };
  }
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.ok && branch.stdout !== "main") {
    return { ok: false, stdout: "", error: `main クローンが ${branch.stdout} を checkout 中のため reset を見送りました` };
  }
  const reset = await git(cwd, ["reset", "--hard", "origin/main"]);
  if (!reset.ok) return reset;
  return git(cwd, ["rev-parse", "HEAD"]);
}
