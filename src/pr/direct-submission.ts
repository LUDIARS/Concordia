/**
 * ブランチ直指定 (session 非依存) の local PR 提出。
 *
 * 既存の提出 3 経路 (session.ended 自動 / POST /v1/prs/local / implementation-tools
 * review) はすべて Cc セッション前提で、 Lictor 未ラップの bg job や終了済みセッションの
 * ブランチはレビューへ出せなかった。 ここは repo_path + branch だけで同じ提出判定
 * (`planLocalPrSubmission`) に載せる入口。 session_id は任意 — 渡せば従来どおり
 * Revisor の審査結果 inject が紐づき、 無ければ共有チャット通知のみで完結する。
 *
 * spec/feature/revisor-local-pr-submission.md §8, §9。
 */

import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { isWithinWorkspace } from "../implementation-tools/repo-context.js";
import { submitSessionLocalPr, type LocalPrSubmissionDeps, type LocalPrSubmissionResult } from "./local-pr-submission.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export interface DirectLocalPrRequest {
  /** リポジトリ (worktree 可) の絶対パス。 配下のサブディレクトリでもよい。 */
  repoPath: string;
  /** 提出するブランチ。 省略時は repoPath の checkout ブランチ。 */
  branch?: string;
  /** 任意。 渡すと従来経路と同じ session binding が付き、 審査結果が inject で戻る。 */
  sessionId?: string;
  /**
   * 任意。 提出者が書いた PR 本文。 省略時はコミット件名から自動生成する。
   * 自動生成も Revisor の本文要件 (`## 実装内容` / `## 受け入れ条件`) を満たす。
   */
  prContent?: string;
  /** sessionId と併用する明示 opt-in。省略時は通常キュー。 */
  fastLane?: boolean;
}

export interface DirectLocalPrDeps extends LocalPrSubmissionDeps {
  /** direct 提出を許すルート。 外のパスは扱わない (loopback API でも境界は守る)。 */
  resolveWorkspaceRoots(): readonly string[];
  runGit?: (cwd: string, args: readonly string[]) => Promise<string>;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

/**
 * ブランチ名として git に渡してよいか。 API の外部入力なので、 先頭 `-` (オプション解釈)
 * と rev 構文文字を弾く (branch-commits.ts の isSafeRef と同基準)。
 */
function isSafeBranch(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-") && !/[\s~^:?*[\\]/.test(ref);
}

/**
 * repo_path + branch を検証し、 既存の提出判定へ渡す。 例外は投げず結果として返す
 * (submitSessionLocalPr と同じ契約 — 呼び出し側の API は常に 200 + 理由で応答できる)。
 */
export async function submitDirectLocalPr(
  deps: DirectLocalPrDeps,
  request: DirectLocalPrRequest,
): Promise<LocalPrSubmissionResult> {
  if (request.fastLane === true && !request.sessionId?.trim()) {
    return { submitted: false, reason: "error", detail: "fast lane requires a Concordia session" };
  }
  const runGit = deps.runGit ?? git;
  const requested = request.repoPath.trim();
  if (!requested || !isAbsolute(requested)) {
    return { submitted: false, reason: "error", detail: "repo_path must be an absolute path" };
  }
  if (!(await isWithinWorkspace(requested, deps.resolveWorkspaceRoots()))) {
    return { submitted: false, reason: "error", detail: "repo_path is outside the configured workspace roots" };
  }

  let repoPath: string;
  let repository: string | null;
  try {
    repoPath = resolve(await runGit(requested, ["rev-parse", "--show-toplevel"]));
    repository = await runGit(repoPath, ["remote", "get-url", "origin"]).catch(() => null);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log.warn({ repo_path: requested, err: detail }, "direct local PR repo resolution failed");
    return { submitted: false, reason: "error", detail: "repo_path is not a git repository" };
  }

  let branch = request.branch?.trim() ?? "";
  if (branch) {
    if (!isSafeBranch(branch)) {
      return { submitted: false, reason: "error", detail: "branch contains unsafe characters" };
    }
    // 実在しないブランチは plan の前で止める — no_commits 等の紛らわしい理由にしない。
    const exists = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return { submitted: false, reason: "error", detail: `branch '${branch}' does not exist in ${repoPath}` };
    }
  } else {
    branch = await runGit(repoPath, ["branch", "--show-current"]).catch(() => "");
    // detached HEAD 等は branch 空文字のまま plan へ渡し、 既存の no_branch 理由で返す。
  }

  return submitSessionLocalPr(deps, {
    sessionId: request.sessionId?.trim() || null,
    repoPath,
    repository,
    branch: branch || null,
    prContent: request.prContent?.trim() || null,
    fastLane: request.fastLane === true,
  });
}
