/**
 * run を次の状態へ進める判断 (純関数) と、 その実行。
 *
 * 判断を関数に切り出してあるのは、 「委託がまだ動いている」「審査に落ちた」
 * 「PR を作る前にローカルでマージされた」を Revisor / delegation を立てずに
 * 単体テストで固定するため。
 *
 * @implements spec/feature/github-issue-workflow.md — 状態
 */

import type { GithubIssueRunRow, GithubIssueRunsRepo, GithubIssueRunStatus } from "../db/github-issue-runs-repo.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { RevisorLocalPrSummary } from "../pr/revisor-local-pr-client.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import type { GithubGateway } from "./gh-cli.js";
import { publishReviewedBranch, type PublishDeps } from "./publish.js";
import { failedComment, sanitizeGithubPublicText, skippedComment } from "./text.js";

export type RunTransition =
  | { kind: "wait" }
  | { kind: "mark"; status: GithubIssueRunStatus; detail: string | null; localPrId?: string; notify?: "skipped" | "failed" }
  | { kind: "publish" };

export interface TransitionInput {
  run: GithubIssueRunRow;
  /** 委託 run の状態。 台帳から消えていれば null。 */
  delegationStatus: DelegationRunRow["status"] | null;
  delegationError: string | null;
  /** run のブランチに対応する Revisor local PR。 未提出なら null。 */
  localPr: RevisorLocalPrSummary | null;
}

/** 審査通過 = open のまま test_ok。 これ以外を通過扱いにしない。 */
export function isReviewPassed(localPr: RevisorLocalPrSummary): boolean {
  return localPr.status === "open" && localPr.checkStatus === "test_ok";
}

export function decideRunTransition(input: TransitionInput): RunTransition {
  const { run, localPr } = input;
  if (run.status === "running") {
    if (localPr) return { kind: "mark", status: "pr_submitted", detail: null, localPrId: localPr.id };
    if (input.delegationStatus === "failed" || input.delegationStatus === "spawn_failed") {
      return {
        kind: "mark",
        status: "failed",
        detail: input.delegationError ?? `委託が ${input.delegationStatus} で終わりました`,
        notify: "failed",
      };
    }
    if (input.delegationStatus === "completed") {
      // 完了報告があるのに local PR が無い = 「直さない」判断 (ci-failure-fix と同じ設計)。
      return {
        kind: "mark",
        status: "skipped",
        detail: "委託は完了しましたが PR は提出されませんでした (コード修正なしの判断)",
        notify: "skipped",
      };
    }
    return { kind: "wait" };
  }

  if (run.status === "pr_submitted" || run.status === "review_passed") {
    if (!localPr) return { kind: "wait" };
    if (localPr.status === "merged") {
      // 審査通過を観測する前に着地してしまった場合。 空の PR を作りに行かず人へ返す。
      return {
        kind: "mark",
        status: "failed",
        detail: "GitHub PR を作る前に local PR がマージされました。GitHub への反映は手動で確認してください",
        notify: "failed",
      };
    }
    if (localPr.status !== "open") {
      return {
        kind: "mark",
        status: "failed",
        detail: `local PR が ${localPr.status} になりました`,
        notify: "failed",
      };
    }
    if (localPr.checkStatus === "failed" || localPr.checkStatus === "action_required") {
      return {
        kind: "mark",
        status: "failed",
        detail: `審査が ${localPr.checkStatus} で止まりました`,
        notify: "failed",
      };
    }
    return isReviewPassed(localPr) ? { kind: "publish" } : { kind: "wait" };
  }

  return { kind: "wait" };
}

export interface TrackerDeps extends PublishDeps {
  runs: GithubIssueRunsRepo;
  github: GithubGateway;
  findDelegationRun: (id: string) => DelegationRunRow | null;
  listLocalPrs: () => Promise<RevisorLocalPrSummary[]>;
}

/** 同じ run 台帳に対する巡回を直列化し、長い push 中の interval 重複を防ぐ。 */
const activeAdvances = new WeakMap<GithubIssueRunsRepo, Promise<void>>();

/** run の branch に対応する local PR を選ぶ。 リポジトリと head ref の一致で決める。 */
export function findLocalPrForRun(
  run: GithubIssueRunRow,
  localPrs: readonly RevisorLocalPrSummary[],
): RevisorLocalPrSummary | null {
  if (run.local_pr_id) {
    return localPrs.find((pr) => pr.id === run.local_pr_id) ?? null;
  }
  const repository = normalizeRepoOrigin(run.repo_origin).toLowerCase();
  return localPrs.find((pr) =>
    normalizeRepoOrigin(pr.repository).toLowerCase() === repository
    && pr.headRef === run.branch) ?? null;
}

/** 進行中の run を 1 巡させる。 例外は run 単位で閉じ、 他の run を巻き添えにしない。 */
async function advanceIssueRunsOnce(deps: TrackerDeps): Promise<void> {
  const active = deps.runs.list({ statuses: ["running", "pr_submitted", "review_passed"], limit: 200 });
  if (active.length === 0) return;
  const localPrs = await deps.listLocalPrs();

  for (const run of active) {
    const localPr = findLocalPrForRun(run, localPrs);
    const delegationRun = run.delegation_run_id ? deps.findDelegationRun(run.delegation_run_id) : null;
    const transition = decideRunTransition({
      run,
      delegationStatus: delegationRun?.status ?? null,
      delegationError: delegationRun?.error ?? null,
      localPr,
    });
    if (transition.kind === "wait") continue;

    if (transition.kind === "mark") {
      const detail = transition.detail === null ? null : sanitizeGithubPublicText(transition.detail);
      const updated = deps.runs.update(run.id, {
        status: transition.status,
        detail,
        ...(transition.localPrId ? { localPrId: transition.localPrId } : {}),
      }) ?? run;
      if (transition.notify) {
        const body = transition.notify === "skipped"
          ? skippedComment(detail ?? "")
          : failedComment(detail ?? "");
        await deps.github.commentOnIssue(updated.repo_origin, updated.issue_number, body)
          .catch((error: unknown) => {
            deps.log?.("github_issue_comment_failed", {
              run_id: run.id,
              error_type: error instanceof Error ? error.name : typeof error,
            });
          });
      }
      continue;
    }

    const passed = deps.runs.update(run.id, {
      status: "review_passed",
      ...(localPr ? { localPrId: localPr.id } : {}),
    }) ?? run;
    await publishReviewedBranch(deps, passed, localPr);
  }
}

export function advanceIssueRuns(deps: TrackerDeps): Promise<void> {
  const active = activeAdvances.get(deps.runs);
  if (active) return active;

  let tracked: Promise<void>;
  tracked = advanceIssueRunsOnce(deps).finally(() => {
    if (activeAdvances.get(deps.runs) === tracked) activeAdvances.delete(deps.runs);
  });
  activeAdvances.set(deps.runs, tracked);
  return tracked;
}
