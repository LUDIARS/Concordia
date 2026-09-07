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
import { isReviewPassed, publishReviewedBranch, type PublishDeps } from "./publish.js";
import { failedComment, sanitizeGithubPublicText, skippedComment } from "./text.js";
import {
  ISSUE_DISPATCH_RECOVERY_GRACE_MS,
  isMatchingLegacyDelegation,
  issueDelegationTrigger,
  legacyIssueDelegationTrigger,
} from "./dispatch-state.js";

// 審査通過の判定は publish 側が正本 (公開の入口で同じ規則を再確認するため)。
// 既存の import 元を変えないよう、ここから再輸出する。
export { isReviewPassed };

export type RunTransition =
  | { kind: "wait" }
  | { kind: "mark"; status: GithubIssueRunStatus; detail: string | null; delegationRunId?: string; localPrId?: string; notify?: "skipped" | "failed" }
  | { kind: "publish" };

export interface TransitionInput {
  run: GithubIssueRunRow;
  /** 委託 run の状態。 台帳から消えていれば null。 */
  delegationStatus: DelegationRunRow["status"] | null;
  delegationError: string | null;
  /** run のブランチに対応する Revisor local PR。 未提出なら null。 */
  localPr: RevisorLocalPrSummary | null;
  correlatedDelegation?: DelegationRunRow | null;
  now?: number;
}

export function decideRunTransition(input: TransitionInput): RunTransition {
  const { run, localPr } = input;
  if (run.status === "queued") {
    if (input.correlatedDelegation) {
      return {
        kind: "mark",
        status: "running",
        detail: null,
        delegationRunId: input.correlatedDelegation.id,
      };
    }
    if ((input.now ?? Date.now()) - run.updated_at < ISSUE_DISPATCH_RECOVERY_GRACE_MS) {
      return { kind: "wait" };
    }
    if (run.issue_body_sha256 === null) {
      return {
        kind: "mark",
        status: "dispatch_unknown",
        detail: "旧バージョンの委託起動結果が不明です。重複起動を避けて照合を継続します",
        notify: "failed",
      };
    }
    return {
      kind: "mark",
      status: "failed",
      detail: "Issue 本文の永続化を確認できないまま復旧期限を超えました。自動起動しません",
      notify: "failed",
    };
  }
  if (run.status === "dispatching" || run.status === "dispatch_unknown") {
    if (input.correlatedDelegation) {
      return {
        kind: "mark",
        status: "running",
        detail: null,
        delegationRunId: input.correlatedDelegation.id,
      };
    }
    if (run.status === "dispatching" && (input.now ?? Date.now()) - run.updated_at >= ISSUE_DISPATCH_RECOVERY_GRACE_MS) {
      return {
        kind: "mark",
        status: "dispatch_unknown",
        detail: "委託起動の結果が不明です。重複起動を避けて照合を継続します",
        notify: "failed",
      };
    }
    return { kind: "wait" };
  }
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
  findDelegationRunByTriggeredBy: (triggeredBy: string) => DelegationRunRow | null;
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
  // Dispatch recovery uses only local SQLite correlation. A Revisor outage must not delay
  // binding a child id or surfacing an unknown launch outcome.
  const dispatching = deps.runs.list({
    statuses: ["queued", "dispatching", "dispatch_unknown"],
    limit: 200,
  });
  for (const run of dispatching) {
    const needsCorrelation = run.status === "dispatching" || run.status === "dispatch_unknown"
      || (run.status === "queued" && run.issue_body_sha256 === null);
    const foundDelegation = needsCorrelation
      ? deps.findDelegationRunByTriggeredBy(
        run.issue_body_sha256 === null ? legacyIssueDelegationTrigger(run) : issueDelegationTrigger(run),
      )
      : null;
    const correlatedDelegation = foundDelegation && run.issue_body_sha256 === null
      ? (isMatchingLegacyDelegation(run, foundDelegation) ? foundDelegation : null)
      : foundDelegation;
    const transition = decideRunTransition({
      run,
      delegationStatus: null,
      delegationError: null,
      localPr: null,
      correlatedDelegation,
    });
    await applyMarkTransition(deps, run, transition);
  }

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
      await applyMarkTransition(deps, run, transition);
      continue;
    }

    const passed = deps.runs.updateIfStatus(run.id, run.status, {
      status: "review_passed",
      ...(localPr ? { localPrId: localPr.id } : {}),
    });
    if (!passed) continue;
    await publishReviewedBranch(deps, passed, localPr);
  }
}

async function applyMarkTransition(
  deps: TrackerDeps,
  run: GithubIssueRunRow,
  transition: RunTransition,
): Promise<void> {
  if (transition.kind !== "mark") return;
  const detail = transition.detail === null ? null : sanitizeGithubPublicText(transition.detail);
  const updated = deps.runs.updateIfStatus(run.id, run.status, {
    status: transition.status,
    detail,
    ...(transition.delegationRunId ? { delegationRunId: transition.delegationRunId } : {}),
    ...(transition.localPrId ? { localPrId: transition.localPrId } : {}),
  });
  if (!updated || !transition.notify) return;
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
