// 作業ツリーのコミット代行 (I/O 担当)。 判定は delegation/commit-guard.ts が持つ。
// 規則の説明は spec/feature/work-submission.md §4。
//
// 委託 run とセッションでコミットの作り方が分かれていたので、 git を叩く側をここへ
// 1 本化した。 呼び出し側の違いは「誰の worktree か」と「末尾に何を書くか」だけで、
// 保護ブランチ・範囲・変更数の判定は両方とも同じものを通る。

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { checkCommitAllowed, type CommitGuardRejection } from "../delegation/commit-guard.js";

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const GIT_TIMEOUT_MS = 30_000;

export interface CommitWorktreeInput {
  /** コミットする worktree。 run の spawn_cwd か、 セッションの repo_path */
  cwd: string;
  /** 宣言されたブランチ。 null なら現在のブランチを採用する */
  branch: string | null;
  /** コミットメッセージ (1 行目 = 件名) */
  message: string;
  /** 省略時は worktree の全変更。 指定時はそのパスだけ stage する */
  paths?: readonly string[];
  /** メッセージ末尾に足す行 (Delegated-Run / Cc-Session など) */
  trailers?: readonly string[];
  /** stage の前に消しておくファイル (委託の依頼ファイル) */
  removeBeforeStage?: () => Promise<void>;
}

export type CommitWorktreeOutcome =
  | { ok: true; sha: string; files: number }
  | { ok: false; code: CommitGuardRejection | "git_failed" | "invalid_request"; detail: string };

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * ワークスペースルート (= リポジトリの集合を置いてある親)。 Concordia は
 * `<workspace>/Concordia` で動くので、 その親が既定。 env で上書きできる。
 */
export function workspaceRoots(): string[] {
  const configured = process.env.CONCORDIA_COMMIT_FORBIDDEN_ROOTS;
  if (configured) return configured.split(";").map((p) => p.trim()).filter(Boolean);
  return [resolve(process.cwd(), "..")];
}

/** `git status --porcelain -uall` の出力から変更パスを取り出す (export はテスト用)。 */
export function parseChangedPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    // 「XY <path>」。 rename は "R  old -> new" なので新しい方を採る。
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .map((path) => path.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.slice(0, 500);
  }
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function buildMessage(message: string, trailers: readonly string[]): string {
  const body = message.trim();
  return trailers.length > 0 ? `${body}\n\n${trailers.join("\n")}\n` : `${body}\n`;
}

/** @implements SPEC-WORK-SUBMISSION-COMMIT */
export async function commitWorktree(input: CommitWorktreeInput): Promise<CommitWorktreeOutcome> {
  const { cwd } = input;
  let repoRoot: string;
  let currentBranch: string;
  let changedPaths: string[];
  try {
    repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    currentBranch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    // `-uall` が要る: 既定の porcelain は未追跡ディレクトリを `dir/` 1 行に畳むので、
    // 数千ファイルの新規ディレクトリが「変更 1 件」 に見えて too_many_changes を素通りする。
    // `git add -A` は畳まれた中身を全部 stage するため、 数え方を stage 対象に揃える。
    changedPaths = parseChangedPaths(await git(cwd, ["status", "--porcelain", "-uall"]));
  } catch (error) {
    return { ok: false, code: "git_failed", detail: describeError(error) };
  }

  const verdict = checkCommitAllowed({
    runCwd: cwd,
    runBranch: input.branch,
    repoRoot,
    currentBranch,
    changedPaths,
    forbiddenRoots: workspaceRoots(),
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail };

  await input.removeBeforeStage?.();

  try {
    // hooks はそのまま走らせる (--no-verify は使わない)。
    if (input.paths && input.paths.length > 0) {
      await git(cwd, ["add", "--", ...input.paths]);
    } else {
      await git(cwd, ["add", "-A"]);
    }
    const staged = (await git(cwd, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
    if (staged.length === 0) {
      return { ok: false, code: "nothing_to_commit", detail: "nothing was staged" };
    }
    await git(cwd, ["commit", "-m", buildMessage(input.message, input.trailers ?? [])]);
    const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    return { ok: true, sha, files: staged.length };
  } catch (error) {
    return { ok: false, code: "git_failed", detail: describeError(error) };
  }
}
