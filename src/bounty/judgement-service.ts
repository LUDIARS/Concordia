/**
 * 再審と権限者による判定の変更 (spec/feature/bug-bounty.md §5 SPEC-BOUNTY-APPEAL)。
 *
 * - 報告者は判定 (対象外・重複・情報不足) に 1 回だけ再審を求められる。 AI には再判定させず、権限者が決める。
 * - 権限者は再審が無くても判定・深刻度・自己起因を変えられる。 変更は誰がいつ何から何へを履歴に残す
 *   (CC-BOUNTY-INV-08)。 判定の状態は遷移表 (report-state.ts) の CAS で書く。
 * - 採用へ変われば修正の後続 (Actio タスク・hotfix) へ、採用でなくなれば報奨を見直す。
 *
 * 権限 (社員名簿の管理職以上 / WebUI の管理面) の確認は呼び出し側 (API) が行い、ここは actor を記録する。
 *
 * @implements SPEC-BOUNTY-APPEAL
 */

import type { BountyReportRow, BountySeverity, BountyVerdict } from "../db/bounty-reports-repo.js";
import type { BountyReporterKey, BountyReporterRow } from "../db/bounty-reporters-repo.js";
import { authorityNotice, triageReplyMessage } from "./messages.js";
import type { BountyLedger, BountyNotifierPort } from "./ports.js";
import { decideBountyTransition, type BountyReportStatus } from "./report-state.js";
import { resolveDuplicateRoot } from "./triage-result.js";

export const MAX_APPEAL_REASON_CHARS = 1000;
const APPEALABLE: readonly BountyReportStatus[] = ["rejected", "duplicate", "needs_info"];
/** 判定から決まる状態。 採用は修正の段階 (fix_*) にあっても「採用」として扱う。 */
const ACCEPTED_STAGES: readonly BountyReportStatus[] = ["accepted", "fix_pending", "fixing", "fix_submitted", "deployed"];

export type BountyJudgementError =
  | "report_not_found"
  | "not_reporter"
  | "not_appealable"
  | "appeal_used"
  | "no_pending_appeal"
  | "reason_required"
  | "duplicate_target_invalid"
  | "transition_not_allowed"
  | "nothing_changed"
  | "state_changed";

/** 再審を求める報告者。 セッションか、Bot / Cocoiru が渡す人。 */
export type BountyAppealActor =
  | { kind: "session"; sessionId: string }
  | { kind: "person"; key: BountyReporterKey };

export interface BountyJudgementChange {
  verdict?: BountyVerdict;
  severity?: BountySeverity | null;
  selfInflicted?: boolean;
  /** verdict が duplicate のときの重複先。 */
  duplicateOf?: string | null;
  reason: string;
}

export interface BountyJudgementDeps {
  ledger: BountyLedger;
  reporters: { findByKey(key: BountyReporterKey): BountyReporterRow | null };
  sessionActive(sessionId: string): boolean;
  notifier: BountyNotifierPort;
  /** 採用へ変わった報告の後続 (Actio タスク・hotfix)。 */
  onAccepted(reportId: string): Promise<void>;
  /** 判定が変わった報告の報奨の見直し。 */
  reconcileReward(reportId: string, reason: string): void;
  now?: () => number;
}

type Result = { ok: true } | { ok: false; error: BountyJudgementError };

export class BountyJudgementService {
  private readonly now: () => number;

  constructor(private readonly deps: BountyJudgementDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 報告者の再審の申し出 (1 報告 1 回)。 */
  async appeal(input: { reportId: string; actor: BountyAppealActor; reason: string }): Promise<Result> {
    const report = this.deps.ledger.find(input.reportId);
    if (!report) return { ok: false, error: "report_not_found" };
    if (!this.isReporter(report, input.actor)) return { ok: false, error: "not_reporter" };
    if (!APPEALABLE.includes(report.status)) return { ok: false, error: "not_appealable" };
    if (report.appeal_requested_at !== null) return { ok: false, error: "appeal_used" };
    const reason = input.reason.trim().slice(0, MAX_APPEAL_REASON_CHARS);
    if (!reason) return { ok: false, error: "reason_required" };
    const now = this.now();
    const changed = this.deps.ledger.update({
      id: report.id,
      expectStatus: report.status,
      patch: { appeal_requested_at: now, appeal_reason: reason },
      event: {
        kind: "appeal", from_value: report.verdict, to_value: "requested",
        actor_kind: input.actor.kind === "session" ? "ai" : "human",
        actor_id: input.actor.kind === "session" ? input.actor.sessionId : report.reporter_id,
      },
    }, now);
    if (!changed) return { ok: false, error: "state_changed" };
    await this.deps.notifier.notifyAuthority(authorityNotice("appeal", report.id)).catch(() => false);
    return { ok: true };
  }

  /** 権限者が再審を決める。 認めるなら判定を変え、認めないなら決定だけを残す。 */
  async decideAppeal(input: { reportId: string; authority: string; uphold: boolean; change?: BountyJudgementChange; reason: string }): Promise<Result> {
    const report = this.deps.ledger.find(input.reportId);
    if (!report) return { ok: false, error: "report_not_found" };
    if (report.appeal_requested_at === null || report.appeal_decided_at !== null) return { ok: false, error: "no_pending_appeal" };
    const reason = input.reason.trim();
    if (!reason) return { ok: false, error: "reason_required" };
    if (input.uphold && input.change) {
      const changed = await this.change({ reportId: report.id, authority: input.authority, change: { ...input.change, reason } });
      if (!changed.ok) return changed;
    }
    const now = this.now();
    this.deps.ledger.update({
      id: report.id,
      patch: { appeal_decided_at: now },
      event: { kind: "appeal", to_value: input.uphold ? "upheld" : "dismissed", actor_kind: "human", actor_id: input.authority },
    }, now);
    const latest = this.deps.ledger.find(report.id)!;
    await this.deps.notifier.replyToReporter(latest, input.uphold
      ? `再審の結果、判定を見直しました。\n${triageReplyMessage(latest)}`
      : `バグ報告 \`${latest.id}\` の再審の結果、判定は変わりませんでした。`).catch(() => false);
    return { ok: true };
  }

  /** 権限者による判定・深刻度・自己起因の変更。 */
  async change(input: { reportId: string; authority: string; change: BountyJudgementChange }): Promise<Result> {
    const report = this.deps.ledger.find(input.reportId);
    if (!report) return { ok: false, error: "report_not_found" };
    const reason = input.change.reason.trim().slice(0, MAX_APPEAL_REASON_CHARS);
    if (!reason) return { ok: false, error: "reason_required" };
    const before = judgementOf(report);
    const now = this.now();
    const patch: Parameters<BountyLedger["update"]>[0]["patch"] = {};
    if (input.change.severity !== undefined) patch.severity = input.change.severity;
    if (input.change.selfInflicted !== undefined) patch.self_inflicted = input.change.selfInflicted ? 1 : 0;

    let target: BountyReportStatus | null = null;
    const verdict = input.change.verdict;
    if (verdict !== undefined && verdict !== report.verdict) {
      target = statusForVerdict(verdict, report.status);
      if (!target) return { ok: false, error: "transition_not_allowed" };
      patch.verdict = verdict;
      patch.verdict_reason = reason;
      if (verdict === "duplicate") {
        const root = input.change.duplicateOf ? resolveDuplicateRoot(input.change.duplicateOf, (id) => this.deps.ledger.find(id)) : null;
        if (!root || root.id === report.id || root.project_code !== report.project_code) {
          return { ok: false, error: "duplicate_target_invalid" };
        }
        patch.duplicate_of = root.id;
      } else {
        patch.duplicate_of = null;
      }
      if (target === "accepted" && report.project_code === null) return { ok: false, error: "transition_not_allowed" };
    }
    if (Object.keys(patch).length === 0) return { ok: false, error: "nothing_changed" };
    const after = { ...before, ...pick(patch as Record<string, unknown>) };
    const event = {
      kind: "verdict_changed" as const,
      from_value: JSON.stringify(before),
      to_value: JSON.stringify({ ...after, reason }),
      actor_kind: "human" as const,
      actor_id: input.authority,
    };
    let changed: boolean;
    if (target && target !== report.status) {
      if (!decideBountyTransition({ from: report.status, to: target }).ok) return { ok: false, error: "transition_not_allowed" };
      // 遷移の履歴 (from/to は状態) とは別に、判定の前後を verdict_changed で残す。
      changed = this.deps.ledger.transition({
        id: report.id, from: report.status, to: target, patch,
        event: { kind: "verdict_changed", actor_kind: "human", actor_id: input.authority },
      }, now);
      if (changed) this.deps.ledger.recordEvent(report.id, event, now);
    } else {
      changed = this.deps.ledger.update({ id: report.id, expectStatus: report.status, patch, event }, now);
    }
    if (!changed) return { ok: false, error: "state_changed" };
    if (target === "accepted") await this.deps.onAccepted(report.id);
    this.deps.reconcileReward(report.id, reason);
    return { ok: true };
  }

  private isReporter(report: BountyReportRow, actor: BountyAppealActor): boolean {
    if (actor.kind === "session") {
      return report.reporter_kind === "session" && report.reporter_session_id === actor.sessionId
        && this.deps.sessionActive(actor.sessionId);
    }
    const person = this.deps.reporters.findByKey(actor.key);
    return !!person && report.reporter_kind === "person" && report.reporter_id === person.id;
  }
}

/** 判定の変更で移る状態。 採用の段階にある報告を採用へ戻すことはない (状態は変えない)。 */
function statusForVerdict(verdict: BountyVerdict, current: BountyReportStatus): BountyReportStatus | null {
  if (verdict === "accepted") return ACCEPTED_STAGES.includes(current) ? current : "accepted";
  if (verdict === "needs_info") return current === "received" ? "needs_info" : null;
  if (current === "deployed" || current === "withdrawn") return null;
  return verdict;
}

function judgementOf(report: BountyReportRow) {
  return {
    verdict: report.verdict,
    severity: report.severity,
    self_inflicted: report.self_inflicted,
    duplicate_of: report.duplicate_of,
  };
}

function pick(patch: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of ["verdict", "severity", "self_inflicted", "duplicate_of"]) if (key in patch) out[key] = patch[key];
  return out;
}
