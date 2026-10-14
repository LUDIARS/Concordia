/**
 * 修正の use case (spec/feature/bug-bounty.md §6 §11)。
 *
 * - 採用した報告は hotfix かどうかに関わらず Actio のタスク (種別 issue) を 1 件作り、作れたら `fix_pending`。
 *   作れなければ失敗を記録して判定は保持する。 Actio 不通は定期に再試行し、チーム・責任者が決まらない
 *   失敗は権限者の再試行を待つ。
 * - hotfix の条件 (fix-policy.ts) を満たせば、既存の実装委託を Actio タスク付きで起動する。 run id を先に
 *   台帳へ予約し、結果不明は照合してから扱う。 失敗・停止は `fix_pending` へ戻し、自動で起動し直さない (CC-INV-03)。
 * - 修正の PR と報告の対応を記録する (hotfix は委託 run → そのセッションの PR、バックログはタスクを持つ
 *   セッションの PR)。 PR の提出は反映ではない (`fix_submitted` まで)。
 *
 * @implements SPEC-BOUNTY-FIX
 * @implements SPEC-BOUNTY-HOTFIX
 * @implements SPEC-BOUNTY-FIX-LINK
 */

import { randomUUID } from "node:crypto";
import type { BountyReportRow } from "../db/bounty-reports-repo.js";
import { bountyFixBranch, decideBountyHotfix, startOfDay } from "./fix-policy.js";
import { authorityNotice } from "./messages.js";
import {
  isTerminalRunStatus,
  RETRYABLE_ACTIO_ERRORS,
  type BountyActioError,
  type BountyActioPort,
  type BountyDelegationPort,
  type BountyLedger,
  type BountyNotifierPort,
  type BountyPrLookupPort,
  type BountyProjectsPort,
} from "./ports.js";
import { buildBountyFixTask } from "./fix-task.js";

/** hotfix に使う実装委託 (seed.ts の既存テンプレート)。 */
export const BOUNTY_HOTFIX_CALL_NAME = "fix-bug";
/** Actio 不通の再試行の間隔。 */
const ACTIO_RETRY_INTERVAL_MS = 10 * 60_000;
/** hotfix の予約から run が見えるまでの猶予。 */
const LAUNCH_GRACE_MS = 10 * 60_000;

export type BountyFixError = "report_not_found" | "not_accepted" | "task_exists" | "state_changed";

export interface BountyFixDeps {
  ledger: BountyLedger;
  projects: BountyProjectsPort;
  actio: BountyActioPort;
  delegation: BountyDelegationPort;
  prs: BountyPrLookupPort;
  notifier: BountyNotifierPort;
  /** 設定 `bounty.hotfix_daily_limit`。 */
  hotfixDailyLimit(): number;
  now?: () => number;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export class BountyFixService {
  private readonly now: () => number;

  constructor(private readonly deps: BountyFixDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 採用した報告の後続。 タスクを作り、条件を満たせば hotfix を起動する。 */
  async onAccepted(reportId: string): Promise<void> {
    await this.ensureTask(reportId);
    await this.maybeHotfix(reportId);
  }

  /** 権限者の再試行 (WebUI)。 失敗の種類を問わずもう一度作る。 */
  async retryTask(reportId: string): Promise<{ ok: true; created: boolean } | { ok: false; error: BountyFixError }> {
    const report = this.deps.ledger.find(reportId);
    if (!report) return { ok: false, error: "report_not_found" };
    if (report.status !== "accepted") return { ok: false, error: report.actio_task_ref ? "task_exists" : "not_accepted" };
    const created = await this.ensureTask(reportId);
    if (created) await this.maybeHotfix(reportId);
    return { ok: true, created };
  }

  /** 定期の処理: Actio の再試行、hotfix の run の照合、PR の記録。 */
  async tick(): Promise<void> {
    const now = this.now();
    for (const report of this.deps.ledger.listByStatus(["accepted"], 50)) {
      const retryable = report.actio_task_error === null
        || RETRYABLE_ACTIO_ERRORS.some((code) => report.actio_task_error!.startsWith(`${code}:`));
      if (!retryable) continue;
      if (report.actio_task_attempted_at !== null && now - report.actio_task_attempted_at < ACTIO_RETRY_INTERVAL_MS) continue;
      await this.onAccepted(report.id);
    }
    for (const report of this.deps.ledger.listByStatus(["fixing"], 50)) await this.reconcileHotfix(report);
    for (const report of this.deps.ledger.listByStatus(["fix_pending"], 100)) this.recordBacklogPr(report);
  }

  /** Actio のタスクを作る。 作れたら true。 */
  private async ensureTask(reportId: string): Promise<boolean> {
    const report = this.deps.ledger.find(reportId);
    if (!report || report.status !== "accepted" || report.actio_task_ref || !report.project_code) return false;
    const now = this.now();
    const task = buildBountyFixTask(report);
    let outcome: Awaited<ReturnType<BountyActioPort["createIssueTask"]>>;
    try {
      outcome = await this.deps.actio.createIssueTask({
        reportId: report.id,
        project: report.project_code,
        subsidiaryId: report.subsidiary_id,
        title: task.title,
        description: task.description,
      });
    } catch (error) {
      outcome = { ok: false, error: "actio_unavailable", detail: (error as Error).message };
    }
    if (!outcome.ok) {
      this.recordTaskFailure(report, outcome.error, outcome.detail, now);
      return false;
    }
    const changed = this.deps.ledger.transition({
      id: report.id,
      from: "accepted",
      to: "fix_pending",
      patch: { actio_task_ref: outcome.taskRef, actio_task_error: null, actio_task_attempted_at: now },
      event: { kind: "task_created", actor_kind: "system", actor_id: outcome.taskRef },
    }, now);
    return changed;
  }

  private recordTaskFailure(report: BountyReportRow, error: BountyActioError, detail: string, now: number): void {
    const message = `${error}:${detail.replace(/\s+/gu, " ").slice(0, 300)}`;
    this.deps.ledger.update({
      id: report.id,
      expectStatus: "accepted",
      patch: { actio_task_error: message, actio_task_attempted_at: now },
      event: { kind: "task_created", to_value: `failed:${error}`, actor_kind: "system" },
    }, now);
    this.deps.log?.warn(`bounty actio task failed report=${report.id} error=${error}`);
  }

  private async maybeHotfix(reportId: string): Promise<void> {
    const report = this.deps.ledger.find(reportId);
    if (!report || !report.project_code) return;
    const now = this.now();
    const decision = decideBountyHotfix({
      status: report.status,
      verdict: report.verdict,
      hotfixEligible: report.hotfix_eligible === 1,
      revisorWorkflow: this.deps.projects.revisorWorkflow(report.project_code),
      actioTaskRef: report.actio_task_ref,
      hotfixStartedAt: report.hotfix_started_at,
      hotfixesToday: this.deps.ledger.countHotfixesSince(report.project_code, startOfDay(now)),
      dailyLimit: this.deps.hotfixDailyLimit(),
    });
    if (!decision.ok) return;
    const cwd = this.deps.projects.repoPath(report.project_code);
    if (!cwd) return;
    const runId = randomUUID();
    // 予約と遷移を先に書く。 起動の結果が失われても、同じ報告の hotfix を二重に起動しない。
    const reserved = this.deps.ledger.transition({
      id: report.id,
      from: "fix_pending",
      to: "fixing",
      patch: { hotfix_run_id: runId, hotfix_started_at: now },
      event: { kind: "hotfix_started", actor_kind: "system", actor_id: runId },
    }, now);
    if (!reserved) return;
    const task = buildBountyFixTask(report);
    try {
      const launched = await this.deps.delegation.launch({
        runId,
        callName: BOUNTY_HOTFIX_CALL_NAME,
        cwd,
        project: report.project_code,
        branch: bountyFixBranch(report.id),
        taskflowReference: report.actio_task_ref!,
        args: { description: task.delegationBody, target_repo: cwd },
      });
      if (!launched.ok) await this.returnToPending(report.id, runId, launched.error);
    } catch (error) {
      // 結果不明。 予約を残し、定期の照合で run の有無を確かめる。
      this.deps.log?.warn(`bounty hotfix launch unknown report=${report.id}: ${(error as Error).message}`);
    }
  }

  /** hotfix の run を照合する: PR が出ていれば記録、失敗・停止は修正待ちへ戻す。 */
  private async reconcileHotfix(report: BountyReportRow): Promise<void> {
    if (!report.hotfix_run_id || !report.project_code) return;
    const run = this.deps.delegation.findRun(report.hotfix_run_id);
    if (!run) {
      if (report.hotfix_started_at !== null && this.now() - report.hotfix_started_at < LAUNCH_GRACE_MS) return;
      await this.returnToPending(report.id, report.hotfix_run_id, "run_not_found");
      return;
    }
    const pr = run.childSessionId ? this.deps.prs.prOfSession(run.childSessionId, report.project_code) : null;
    if (pr) {
      this.recordPr(report, "fixing", pr);
      return;
    }
    if (isTerminalRunStatus(run.status)) await this.returnToPending(report.id, report.hotfix_run_id, `run_${run.status}_without_pr`);
  }

  /** バックログの修正: タスクを持つセッションが出した PR を記録する。 */
  private recordBacklogPr(report: BountyReportRow): void {
    if (!report.actio_task_ref || !report.project_code || report.fix_pr) return;
    for (const sessionId of this.deps.prs.sessionsOfTask(report.actio_task_ref)) {
      const pr = this.deps.prs.prOfSession(sessionId, report.project_code);
      if (pr) {
        this.recordPr(report, "fix_pending", pr);
        return;
      }
    }
  }

  private recordPr(report: BountyReportRow, from: "fixing" | "fix_pending", pr: string): void {
    this.deps.ledger.transition({
      id: report.id,
      from,
      to: "fix_submitted",
      patch: { fix_pr: pr },
      event: { kind: "pr_recorded", actor_kind: "system", actor_id: pr },
    }, this.now());
  }

  private async returnToPending(reportId: string, runId: string, reason: string): Promise<void> {
    const changed = this.deps.ledger.transition({
      id: reportId,
      from: "fixing",
      to: "fix_pending",
      event: { kind: "hotfix_started", actor_kind: "system", actor_id: `${runId}:${reason}` },
    }, this.now());
    if (changed) await this.deps.notifier.notifyAuthority(authorityNotice("hotfix_failed", reportId, reason)).catch(() => false);
  }
}
