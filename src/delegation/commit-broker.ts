// 委託 run のコミット代行 (spec/feature/delegation.md §14)。 guard (commit-guard.ts) を
// 通したうえで、 git の実行は work-submission/commit-worktree.ts に任せる。
//
// 背景と責務分担は commit-guard.ts の冒頭を参照。 ここは委託固有の入出力
// (依頼ファイル・run の trailer) だけを持ち、 判定も git 実行も持たない。

import { commitWorktree, parseChangedPaths } from "../work-submission/commit-worktree.js";
import { readCommitRequest, removeCommitRequest, type CommitRequest } from "./commit-request.js";
import type { CommitGuardRejection } from "./commit-guard.js";

export { parseChangedPaths };

/**
 * コミット代行に必要な run の情報だけを受ける。 DelegationRunRow をそのまま
 * 受けないのは、 このモジュールを repo 層に依存させないため (テストも楽になる)。
 */
export interface CommitTargetRun {
  id: string;
  spawn_cwd?: string | null;
  spawn_branch?: string | null;
  target_provider?: string | null;
}

export type CommitOutcome =
  | { ok: true; sha: string; files: number }
  | { ok: false; code: CommitGuardRejection | "git_failed" | "invalid_request"; detail: string };

/** @implements SPEC-DELEGATION-COMMIT-BROKER */
export async function commitForRun(
  run: CommitTargetRun,
  request: CommitRequest,
): Promise<CommitOutcome> {
  if (!run.spawn_cwd) {
    return { ok: false, code: "run_cwd_unknown", detail: "this run has no spawn_cwd" };
  }
  const cwd: string = run.spawn_cwd;
  const trailers = [`Delegated-Run: ${run.id}`];
  if (run.target_provider) trailers.push(`Delegated-Provider: ${run.target_provider}`);
  return await commitWorktree({
    cwd,
    branch: run.spawn_branch ?? null,
    message: request.message,
    ...(request.paths && request.paths.length > 0 ? { paths: request.paths } : {}),
    trailers,
    // 依頼ファイル自体はコミットに含めない。 `git add -A` は cwd 直下の
    // `.concordia-commit.json` も拾うので、 stage 前に消しておかないと
    // 「依頼が履歴に残り、 その後の unlink で worktree が dirty のまま」 になる。
    removeBeforeStage: () => removeCommitRequest(cwd),
  });
}

/**
 * cwd に置かれた依頼ファイルがあればコミットする。 run 終了時の掃き出しに使う。
 * 依頼が無ければ null (= 何もしない、 正常系)。
 */
export async function commitFromRequestFile(run: CommitTargetRun): Promise<CommitOutcome | null> {
  if (!run.spawn_cwd) return null;
  const read = await readCommitRequest(run.spawn_cwd);
  if (read.kind === "none") return null;
  if (read.kind === "invalid") {
    // 依頼はあったが形が違う。 消さずに残すと後続 run の `git add -A` が拾ってしまうので
    // 消したうえで、 拒否理由を委託元に返す (黙って捨てない)。
    await removeCommitRequest(run.spawn_cwd);
    return { ok: false, code: "invalid_request", detail: read.detail };
  }

  const outcome = await commitForRun(run, read.request);
  // commitForRun は stage 前に消すが、 guard 拒否で そこまで届かない経路がある。
  // 失敗しても消す — 残すと同じ依頼で毎回失敗し続けるため
  // (理由は呼び出し側がログ / run.error に残す)。
  await removeCommitRequest(run.spawn_cwd);
  return outcome;
}
