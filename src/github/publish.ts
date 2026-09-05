/**
 * 審査を通ったブランチを GitHub に着地させる (push → PR → Issue コメント)。
 *
 * ここに LLM は挟まない。 「何を直したか」は審査済み local PR の説明をそのまま運ぶ。
 *
 * @implements spec/feature/github-issue-workflow.md — パイプライン
 */

import type { GithubIssueRunRow, GithubIssueRunsRepo } from "../db/github-issue-runs-repo.js";
import type { RevisorLocalPrSummary } from "../pr/revisor-local-pr-client.js";
import type { BranchPusher } from "./branch-push.js";
import type { GithubGateway } from "./gh-cli.js";
import { publishedComment, pullRequestBody, pullRequestTitle, sanitizeGithubPublicText } from "./text.js";

export interface PublishDeps {
  runs: GithubIssueRunsRepo;
  github: GithubGateway;
  pusher: BranchPusher;
  /** PR の base。 設定変更が次の公開から効くよう、 値ではなく解決関数で受ける。 */
  baseBranch: () => string;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export type PublishOutcome =
  | { kind: "published"; run: GithubIssueRunRow; prUrl: string }
  | { kind: "failed"; run: GithubIssueRunRow; detail: string };

/** 委託が書いた local PR の説明。 無ければ空文字 (捏造しない)。 */
function summaryOf(localPr: RevisorLocalPrSummary | null): string {
  return localPr?.body?.trim() ?? "";
}

export async function publishReviewedBranch(
  deps: PublishDeps,
  run: GithubIssueRunRow,
  localPr: RevisorLocalPrSummary | null,
): Promise<PublishOutcome> {
  const log = deps.log ?? (() => {});
  try {
    await deps.pusher.push({
      repoPath: run.repo_path,
      branch: run.branch,
      actor: `concordia-github-issue:${run.id}`,
    });
    // 再実行や手動作成で既に PR があることがある。 二重に立てない。
    const existing = await deps.github.findPullRequestByHead(run.repo_origin, run.branch);
    const summary = summaryOf(localPr);
    const prUrl = existing ?? await deps.github.createPullRequest({
      repoOrigin: run.repo_origin,
      head: run.branch,
      base: deps.baseBranch(),
      title: pullRequestTitle(run),
      body: pullRequestBody({
        run,
        summary,
        reviewNote: localPr
          ? `- Revisor local PR \`${localPr.id}\` の審査を通過 (checkStatus=${localPr.checkStatus})`
          : "- Revisor local PR の審査を通過",
      }),
    });
    const published = deps.runs.update(run.id, {
      status: "published",
      githubPrUrl: prUrl,
      detail: existing ? "既存 PR を再利用" : null,
    }) ?? run;
    // PR 作成済みなら publication は完了している。通知だけの失敗で failed へ戻すと retry が
    // 新しい委託を起動してしまうため、コメントは best-effort として状態から分離する。
    await deps.github.commentOnIssue(run.repo_origin, run.issue_number, publishedComment({ prUrl, summary }))
      .catch((error: unknown) => {
        deps.log?.("github_issue_comment_failed", {
          run_id: run.id,
          error_type: error instanceof Error ? error.name : typeof error,
        });
      });
    log("github_issue_published", { run_id: run.id, pr_url: prUrl });
    return { kind: "published", run: published, prUrl };
  } catch (error) {
    const detail = sanitizeGithubPublicText(error instanceof Error ? error.message : String(error));
    const failed = deps.runs.update(run.id, { status: "failed", detail }) ?? run;
    log("github_issue_publish_failed", {
      run_id: run.id,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    return { kind: "failed", run: failed, detail };
  }
}
