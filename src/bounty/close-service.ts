/**
 * 反映確認・報奨の依頼 (spec/feature/bug-bounty.md §7)。
 *
 * - デプロイ (service-deployed-notify) が Revisor から取った変更に `fix_pr` が含まれていれば、その報告を
 *   `deployed` にする。 同じデプロイは台帳 (code, current_hash) が 1 回しか処理しないので反映確認も 1 回。
 * - 権限者は根拠付きで手動クローズできる。 Actio のタスクが done になっただけでは閉じず、権限者へ 1 回だけ知らせる
 *   (CC-BOUNTY-INV-09)。
 * - 反映確認と同じ流れで報奨を依頼する (判定は reward-decision.ts、付与は個人の AI 予算の port)。 判定が覆ったら
 *   取り消しを依頼する。 受付口への返信が届かなくても、反映と報奨は取り消さない (CC-INV-06)。
 *
 * @implements SPEC-BOUNTY-CLOSE
 * @implements SPEC-BOUNTY-REWARD
 */

import type { BountyReportRow } from "../db/bounty-reports-repo.js";
import { authorityNotice, deployedReplyMessage } from "./messages.js";
import type {
  BountyActioPort,
  BountyLedger,
  BountyNotifierPort,
  BountyReporterLookup,
  BountyRewardPort,
} from "./ports.js";
import { decideBountyTransition, type BountyReportStatus } from "./report-state.js";
import { displayPublicName } from "./reporter.js";
import { decideBountyRewardRequest, type BountyRewardSkip } from "./reward-decision.js";

const CLOSABLE: readonly BountyReportStatus[] = ["fix_pending", "fixing", "fix_submitted"];
export const MAX_CLOSE_EVIDENCE_CHARS = 1000;

/** デプロイ通知の「解決したバグ報告」の 1 行 (service-deployed-notify が組み立てる)。 */
export interface BountyResolvedReport {
  reportId: string;
  title: string;
  reporter: string;
}

export type BountyCloseError = "report_not_found" | "not_closable" | "evidence_required" | "state_changed";

export interface BountyCloseDeps {
  ledger: BountyLedger;
  reporters: BountyReporterLookup;
  rewards: BountyRewardPort;
  actio: BountyActioPort;
  notifier: BountyNotifierPort;
  now?: () => number;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export class BountyCloseService {
  private readonly now: () => number;

  constructor(private readonly deps: BountyCloseDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * デプロイで反映した報告を閉じる。 `pullRequests` は Revisor の変更一覧の PR 番号。
   * 返すのは通知に載せる行 (題名と公開名だけ。 原文と受付口を含めない)。
   */
  async onDeployed(input: { project: string; code: string; hash: string; pullRequests: readonly number[] }): Promise<BountyResolvedReport[]> {
    const prs = input.pullRequests.map((number) => String(number));
    const resolved: BountyResolvedReport[] = [];
    for (const report of this.deps.ledger.listAwaitingDeployByFixPr(input.project, prs)) {
      const closed = await this.close(report, { kind: "deploy", code: input.code, hash: input.hash });
      if (closed) resolved.push(this.resolvedRow(closed));
    }
    return resolved;
  }

  /** 権限者の手動クローズ (`/bug close` / WebUI)。 根拠必須。 */
  async manualClose(input: { reportId: string; actor: string; evidence: string }):
    Promise<{ ok: true } | { ok: false; error: BountyCloseError }> {
    const evidence = input.evidence.trim().slice(0, MAX_CLOSE_EVIDENCE_CHARS);
    if (!evidence || !input.actor.trim()) return { ok: false, error: "evidence_required" };
    const report = this.deps.ledger.find(input.reportId);
    if (!report) return { ok: false, error: "report_not_found" };
    if (!CLOSABLE.includes(report.status)) return { ok: false, error: "not_closable" };
    const closed = await this.close(report, { kind: "manual", reason: evidence, actor: input.actor });
    return closed ? { ok: true } : { ok: false, error: "state_changed" };
  }

  /** 定期の処理: Actio のタスクが done になった報告を権限者へ 1 回だけ知らせる (自動では閉じない)。 */
  async tick(): Promise<void> {
    for (const report of this.deps.ledger.listByStatus(CLOSABLE, 100)) {
      if (!report.actio_task_ref || !report.project_code || report.actio_done_notified_at !== null) continue;
      const status = await this.deps.actio.taskStatus({
        taskRef: report.actio_task_ref, project: report.project_code, subsidiaryId: report.subsidiary_id,
      }).catch(() => null);
      if (status !== "done") continue;
      const now = this.now();
      const marked = this.deps.ledger.update({
        id: report.id,
        patch: { actio_done_notified_at: now },
        event: { kind: "notified", to_value: "actio_done_authority", actor_kind: "system" },
      }, now);
      if (marked) await this.deps.notifier.notifyAuthority(authorityNotice("actio_done", report.id)).catch(() => false);
    }
  }

  /**
   * 判定が覆ったときの報奨の見直し (judgement-service が呼ぶ)。 付与済みで条件を満たさなくなったら
   * 取り消しを依頼し、まだ付けていない反映済みの報告が条件を満たすようになったら付ける。
   */
  reconcileReward(reportId: string, reason: string): void {
    const report = this.deps.ledger.find(reportId);
    if (!report) return;
    const decision = this.rewardDecision(report);
    if (report.reward_state === "granted" && !decision.request) {
      const revoked = this.deps.rewards.revokeReward({ kind: "bounty", sourceRef: report.id, reason });
      if (revoked.status !== "not_granted") {
        this.deps.ledger.update({
          id: report.id,
          patch: { reward_state: "revoked", reward_note: reason.slice(0, 300) },
          event: { kind: "reward", to_value: "revoked", actor_kind: "system" },
        }, this.now());
      }
      return;
    }
    if (report.status === "deployed" && report.reward_state !== "granted" && decision.request) this.reward(report);
  }

  private async close(
    report: BountyReportRow,
    evidence: { kind: "deploy"; code: string; hash: string } | { kind: "manual"; reason: string; actor: string },
  ): Promise<BountyReportRow | null> {
    if (!decideBountyTransition({ from: report.status, to: "deployed", deploymentEvidence: evidence }).ok) return null;
    const now = this.now();
    const changed = this.deps.ledger.transition({
      id: report.id,
      from: report.status,
      to: "deployed",
      patch: evidence.kind === "deploy"
        ? { deploy_code: evidence.code, deploy_hash: evidence.hash, deployed_at: now }
        : { close_evidence: evidence.reason, closed_by: evidence.actor, deployed_at: now },
      event: evidence.kind === "deploy"
        ? { kind: "deployed", actor_kind: "system", actor_id: `${evidence.code}@${evidence.hash.slice(0, 12)}` }
        : { kind: "deployed", actor_kind: "human", actor_id: evidence.actor },
    }, now);
    if (!changed) return null;
    const rewarded = this.reward(this.deps.ledger.find(report.id)!);
    const closed = this.deps.ledger.find(report.id)!;
    const delivered = await this.deps.notifier.replyToReporter(closed, deployedReplyMessage({
      reportId: closed.id,
      title: closed.public_title,
      rewardTokens: rewarded.tokens,
      rewardSkip: rewarded.skip,
    })).catch(() => false);
    this.deps.ledger.recordEvent(closed.id, {
      kind: "notified", to_value: delivered ? "deployed_delivered" : "deployed_failed", actor_kind: "system",
    }, this.now());
    return closed;
  }

  private rewardDecision(report: BountyReportRow) {
    const recipient = report.recipient_reporter_id ? this.deps.reporters.find(report.recipient_reporter_id) : null;
    return decideBountyRewardRequest({
      verdict: report.verdict,
      duplicateOf: report.duplicate_of,
      selfInflicted: report.self_inflicted === 1,
      recipient: recipient ? { subsidiaryId: recipient.subsidiary_id } : null,
    });
  }

  /** 報奨の依頼。 結果を台帳へ記録する。 */
  private reward(report: BountyReportRow): { tokens: number | null; skip: BountyRewardSkip | null } {
    const decision = this.rewardDecision(report);
    const now = this.now();
    if (!decision.request) {
      this.deps.ledger.update({
        id: report.id,
        patch: { reward_state: "skipped", reward_note: decision.reason },
        event: { kind: "reward", to_value: `skipped:${decision.reason}`, actor_kind: "system" },
      }, now);
      return { tokens: null, skip: decision.reason };
    }
    const recipient = this.deps.reporters.find(report.recipient_reporter_id!)!;
    const outcome = this.deps.rewards.requestReward({
      kind: "bounty",
      sourceRef: report.id,
      recipient: {
        subsidiaryId: recipient.subsidiary_id,
        platform: recipient.platform === "discord" || recipient.platform === "slack" ? recipient.platform : null,
        platformUserId: recipient.platform_user_id,
      },
      severity: report.severity,
    });
    if (outcome.status === "skipped") {
      this.deps.ledger.update({
        id: report.id,
        patch: { reward_state: "skipped", reward_note: `${outcome.reason}: ${outcome.detail}`.slice(0, 300) },
        event: { kind: "reward", to_value: `skipped:${outcome.reason}`, actor_kind: "system" },
      }, now);
      return { tokens: null, skip: null };
    }
    this.deps.ledger.update({
      id: report.id,
      patch: { reward_state: "granted", reward_tokens: outcome.entry.tokens, reward_note: null },
      event: { kind: "reward", to_value: `granted:${outcome.entry.tokens}`, actor_kind: "system" },
    }, now);
    return { tokens: outcome.entry.tokens, skip: null };
  }

  private resolvedRow(report: BountyReportRow): BountyResolvedReport {
    const named = report.reporter_kind === "person" ? report.reporter_id : report.recipient_reporter_id;
    const publicName = named ? this.deps.reporters.find(named)?.public_name ?? null : null;
    return {
      reportId: report.id,
      title: report.public_title ?? "(題名なし)",
      reporter: displayPublicName({ kind: report.reporter_kind, publicName }),
    };
  }
}
