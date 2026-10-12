// GitHub Workflow の提出 (use case): revisor push でブランチを送り、GitHub PR を作る。
// 送出の認可は Revisor、PR の作成は gh CLI が持つ。ここは順序・二重作成の防止・失敗の種類分けだけを持つ。
// 規則の説明は spec/feature/work-submission.md §5。

import type { BranchPusher } from "../github/branch-push.js";
import type { GithubGateway } from "../github/gh-cli.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";

export interface GithubPrSubmitDeps {
  pusher: BranchPusher;
  github: Pick<GithubGateway, "createPullRequest" | "findPullRequestByHead">;
  /** PR の base。 設定変更が次の提出から効くよう解決関数で受ける。 */
  baseBranch: () => string;
}

export interface GithubPrSubmitInput {
  sessionId: string;
  repoPath: string;
  repoOrigin: string | null | undefined;
  branch: string | null | undefined;
  title: string;
  body: string;
}

/** 呼び出し側が次の手を選べる粒度の失敗。 */
export type GithubPrFailure =
  | "origin_unknown"
  | "protected_branch"
  | "auth"
  | "push_failed"
  | "pr_create_failed";

export type GithubPrSubmitResult =
  | { submitted: true; prUrl: string; created: boolean }
  | { submitted: false; reason: GithubPrFailure; next_action: string };

const NEXT_ACTION: Record<GithubPrFailure, string> = {
  origin_unknown: "セッションの repo_origin を owner/repo に解ける GitHub URL で登録し直す。",
  protected_branch: "main 等の保護ブランチからは提出しない。作業ブランチを切って登録し直す。",
  auth: "GitHub / Revisor の認証を人間に更新してもらう。認証が戻るまで再送しない。",
  push_failed: "Revisor の push 結果を確認する。送れていなければ同じブランチで再提出する。",
  pr_create_failed: "ブランチは送信済み。GitHub に同じ head の PR が無いことを確かめてから再提出する。",
};

const PROTECTED = new Set(["main", "master"]);
const AUTH_RE = /\b(?:401|403)\b|auth|credential|permission denied|not logged in/i;
const PROTECTED_RE = /protected branch|GH006/i;
const EXISTING_PR_RE = /already exists/i;

function failed(reason: GithubPrFailure): GithubPrSubmitResult {
  return { submitted: false, reason, next_action: NEXT_ACTION[reason] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ブランチ送出 → 既存 PR の照合 → 作成。 同じ head の PR は作り直さない。 */
export async function submitGithubPr(deps: GithubPrSubmitDeps, input: GithubPrSubmitInput): Promise<GithubPrSubmitResult> {
  const origin = normalizeRepoOrigin(input.repoOrigin ?? "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(origin)) return failed("origin_unknown");
  const branch = input.branch?.trim() ?? "";
  const base = deps.baseBranch();
  if (!branch || branch === base || PROTECTED.has(branch)) return failed("protected_branch");

  try {
    // push は冪等。 PR が既にあっても追加コミットを送るため先に行う。
    await deps.pusher.push({ repoPath: input.repoPath, branch, actor: `concordia-session:${input.sessionId}` });
  } catch (error) {
    const detail = messageOf(error);
    return failed(AUTH_RE.test(detail) ? "auth" : PROTECTED_RE.test(detail) ? "protected_branch" : "push_failed");
  }

  try {
    const existing = await deps.github.findPullRequestByHead(origin, branch);
    if (existing) return { submitted: true, prUrl: existing, created: false };
    const prUrl = await deps.github.createPullRequest({ repoOrigin: origin, head: branch, base, title: input.title, body: input.body });
    return { submitted: true, prUrl, created: true };
  } catch (error) {
    const detail = messageOf(error);
    if (AUTH_RE.test(detail)) return failed("auth");
    if (EXISTING_PR_RE.test(detail)) {
      // 照合と作成の間に別経路で作られた。 作り直さず、その PR を返す。
      const raced = await deps.github.findPullRequestByHead(origin, branch).catch(() => null);
      if (raced) return { submitted: true, prUrl: raced, created: false };
    }
    return failed("pr_create_failed");
  }
}
