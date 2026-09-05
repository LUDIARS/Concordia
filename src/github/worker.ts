/**
 * GitHub Issue ワークフローの常駐部。
 *
 * 2 つのループを持つ:
 *   - 追跡 (短周期): 進行中 run を次の状態へ進め、 審査通過を見つけたら公開する。
 *   - ポーリング (長周期): webhook の取りこぼしを拾う。 webhook が主、 こちらは保険。
 *
 * @implements spec/feature/github-issue-workflow.md — 受信の二重化
 */

import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";
import { isOwnerRepo, normalizeRepoOrigin } from "../pr/normalize.js";
import type { GithubWorkflowConfig } from "./config.js";
import { dispatchIssueTrigger, type GithubDispatchDeps } from "./dispatch.js";
import { sameLabel } from "./issue-event.js";
import { advanceIssueRuns, type TrackerDeps } from "./tracker.js";

const TRACK_INTERVAL_MS = 60_000;

export interface GithubIssueWorkerDeps extends TrackerDeps {
  dispatch: GithubDispatchDeps;
  projects: Pick<ProjectCodesRepo, "list" | "listGithubIssueWorkflow">;
  config: GithubWorkflowConfig;
  /** 処理済み delivery 記録の掃除。 未注入なら掃除しない (テスト用)。 */
  pruneDeliveries?: () => number;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
}

export interface GithubIssueWorkerHandle {
  stop: () => void;
  /** テスト / 手動用。 */
  pollOnce: () => Promise<{ scanned: number; dispatched: number }>;
  trackOnce: () => Promise<void>;
}

/**
 * opt-in プロジェクトの open な該当 Issue を引き、 run の無いものを起動する。
 * 重複は run の一意制約が弾くので、 ここでは「見つけたら投げる」だけでよい。
 */
export async function pollLabeledIssues(
  deps: GithubIssueWorkerDeps,
): Promise<{ scanned: number; dispatched: number }> {
  const label = deps.config.label();
  let scanned = 0;
  let dispatched = 0;
  for (const project of deps.projects.listGithubIssueWorkflow()) {
    const repoOrigin = normalizeRepoOrigin(project.repo_origin ?? "");
    if (!isOwnerRepo(repoOrigin)) {
      deps.logger?.warn(`github issue poll skipped ${project.code}: repo_origin is not a GitHub URL`);
      continue;
    }
    let issues;
    try {
      issues = await deps.github.listLabeledIssues(repoOrigin, label);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : typeof error;
      deps.logger?.warn(`github issue poll failed for ${repoOrigin} (${errorType})`);
      continue;
    }
    for (const issue of issues) {
      scanned += 1;
      const matched = issue.labels.find((name) => sameLabel(name, label));
      if (!matched) continue;
      if (deps.runs.findByIssue(repoOrigin, issue.number, matched)) continue;
      // Issue author を labeler の代わりにすると、第三者が trusted user の Issue へ後から
      // ラベルを付けるだけで認可を迂回できる。event 履歴から labeler を確定できない場合は
      // dispatch せず、webhook または次回 poll を待つ (fail-closed)。
      let actor: string | null;
      try {
        actor = await deps.github.findLabelActor(repoOrigin, issue.number, matched);
      } catch (error) {
        const errorType = error instanceof Error ? error.name : typeof error;
        deps.logger?.warn(
          `github issue poll could not resolve label actor for ${repoOrigin}#${issue.number} (${errorType})`,
        );
        continue;
      }
      if (!actor) {
        deps.logger?.warn(`github issue poll skipped ${repoOrigin}#${issue.number}: label actor is unknown`);
        continue;
      }
      const outcome = await dispatchIssueTrigger(deps.dispatch, {
        repoOrigin,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body,
        issueUrl: issue.url,
        label: matched,
        actor,
        issueAuthor: issue.author,
      });
      // 承認待ちで止まった分も「拾えた」に数える。 次の poll で拾い直さないため。
      if (outcome.kind === "dispatched" || outcome.kind === "awaiting_approval") dispatched += 1;
    }
  }
  return { scanned, dispatched };
}

export function startGithubIssueWorker(deps: GithubIssueWorkerDeps): GithubIssueWorkerHandle {
  const log = deps.logger ?? { info: () => {}, warn: () => {} };

  const trackOnce = async (): Promise<void> => {
    await advanceIssueRuns(deps);
  };
  const pollOnce = (): Promise<{ scanned: number; dispatched: number }> => pollLabeledIssues(deps);

  let tracker: SupervisedIntervalHandle | null = startSupervisedInterval(
    "github-issue-track",
    trackOnce,
    { intervalMs: TRACK_INTERVAL_MS, initialDelayMs: 20_000, log: { warn: (message) => log.warn(message) } },
  );
  let poller: SupervisedIntervalHandle | null = startSupervisedInterval(
    "github-issue-poll",
    async () => {
      // 重複排除の記録は放っておくと増え続ける。 GitHub の再送は数時間で止まるので、
      // 保持期間を過ぎた行はポーリングのついでに落とす。
      deps.pruneDeliveries?.();
      const result = await pollOnce();
      if (result.dispatched > 0) {
        log.info(`github issue poll: scanned=${result.scanned} dispatched=${result.dispatched}`);
      }
    },
    {
      intervalMs: deps.config.pollIntervalMs(),
      initialDelayMs: 45_000,
      log: { warn: (message) => log.warn(message) },
    },
  );

  return {
    stop: () => {
      tracker?.stop();
      poller?.stop();
      tracker = null;
      poller = null;
    },
    pollOnce,
    trackOnce,
  };
}
