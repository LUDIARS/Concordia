/**
 * AI の仕分けの use case (spec/feature/bug-bounty.md §5 §11)。
 *
 * - 起動: `received` の報告ごとに、対象プロジェクトの作業領域を cwd にした読み取り専用の委託を 1 件ずつ起動する。
 *   run id は台帳へ先に書いてから起動し (予約)、結果不明のときは run を照会してから起動し直す。
 * - 結果: `POST /v1/bounty/reports/:id/triage-result` を受けるのは、その報告の仕分けとして起動した run の
 *   セッションだけ。 入口で検証し、不正な結果は保存せず失敗として数える。 3 回で権限者へ回し、自動で
 *   採用・対象外にしない。
 * - 採用した報告は修正の use case へ渡す (Actio タスクの作成・hotfix)。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 */

import { randomUUID } from "node:crypto";
import type { BountyReportRow } from "../db/bounty-reports-repo.js";
import { authorityNotice, triageReplyMessage } from "./messages.js";
import {
  isTerminalRunStatus,
  type BountyDelegationPort,
  type BountyLedger,
  type BountyNotifierPort,
  type BountyProjectsPort,
} from "./ports.js";
import type { BountyReportStatus } from "./report-state.js";
import { buildBountyTriagePrompt, MAX_TRIAGE_OPEN_REPORTS } from "./triage-prompt.js";
import { validateBountyTriageResult } from "./triage-result.js";
import { BOUNTY_TRIAGE_CALL_NAME } from "./triage-template.js";

export { BOUNTY_TRIAGE_CALL_NAME };
/** 失敗がこの回数に達したら権限者へ回す。 */
export const MAX_TRIAGE_FAILURES = 3;
/** 起動を予約してから run が見えるまで待つ時間。 これを過ぎても run が無ければ起動に失敗したとみなす。 */
const LAUNCH_GRACE_MS = 10 * 60_000;
/** 1 回の定期処理で起動する上限。 */
const LAUNCHES_PER_TICK = 3;

export type BountyTriageError =
  | "report_not_found"
  | "not_triage_session"
  | "not_awaiting_triage"
  | "invalid_result"
  | "state_changed";

export interface BountyTriageDeps {
  ledger: BountyLedger;
  projects: BountyProjectsPort;
  delegation: BountyDelegationPort;
  notifier: BountyNotifierPort;
  /** 採用した報告の後続 (Actio タスク・hotfix)。 */
  onAccepted(reportId: string): Promise<void>;
  now?: () => number;
  nonce?: () => string;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

const VERDICT_STATUS: Readonly<Record<string, BountyReportStatus>> = {
  accepted: "accepted",
  duplicate: "duplicate",
  rejected: "rejected",
  needs_info: "needs_info",
};

export class BountyTriageService {
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(private readonly deps: BountyTriageDeps) {
    this.now = deps.now ?? Date.now;
    this.nonce = deps.nonce ?? (() => randomUUID().replace(/-/g, ""));
  }

  /** 定期の処理: 起動済みの run を照合し、未起動の報告を起動する。 */
  async tick(): Promise<void> {
    let launched = 0;
    for (const report of this.deps.ledger.listByStatus(["received"], 50)) {
      if (report.triage_escalated_at !== null) continue;
      if (report.triage_run_id && !this.reconcileRun(report)) continue;
      const current = this.deps.ledger.find(report.id);
      if (!current || current.status !== "received" || current.triage_run_id) continue;
      if (current.triage_failures >= MAX_TRIAGE_FAILURES) {
        await this.escalate(current);
        continue;
      }
      if (launched >= LAUNCHES_PER_TICK) continue;
      if (await this.launch(current)) launched += 1;
    }
  }

  /** 仕分けセッションからの結果を受ける。 */
  async acceptResult(input: { sessionId: string; reportId: string; raw: unknown }):
    Promise<{ ok: true; status: BountyReportStatus } | { ok: false; error: BountyTriageError; errors?: string[] }> {
    const report = this.deps.ledger.find(input.reportId);
    if (!report) return { ok: false, error: "report_not_found" };
    const run = report.triage_run_id ? this.deps.delegation.findRun(report.triage_run_id) : null;
    // その報告の仕分けとして起動した run のセッションだけ (CC-BOUNTY-INV-01)。
    if (!run || !run.childSessionId || run.childSessionId !== input.sessionId) return { ok: false, error: "not_triage_session" };
    if (report.status !== "received") return { ok: false, error: "not_awaiting_triage" };

    const validation = validateBountyTriageResult({
      raw: input.raw,
      report: { id: report.id, project_code: report.project_code },
      find: (id) => this.deps.ledger.find(id),
      registeredProjects: this.deps.projects.registered(),
      companyProjects: this.deps.projects.companyProjects(report.subsidiary_id),
    });
    const now = this.now();
    if (!validation.ok) {
      const failures = report.triage_failures + 1;
      this.deps.ledger.update({
        id: report.id,
        expectStatus: "received",
        patch: { triage_failures: failures },
        event: { kind: "triage_result", to_value: `invalid:${validation.errors.join(",")}`, actor_kind: "ai", actor_id: input.sessionId },
      }, now);
      this.deps.log?.warn(`bounty triage result rejected report=${report.id} errors=${validation.errors.join(",")}`);
      if (failures >= MAX_TRIAGE_FAILURES) await this.escalate(this.deps.ledger.find(report.id) ?? report);
      return { ok: false, error: "invalid_result", errors: validation.errors };
    }

    const result = validation.value;
    const to = VERDICT_STATUS[result.verdict]!;
    const changed = this.deps.ledger.transition({
      id: report.id,
      from: "received",
      to,
      patch: {
        verdict: result.verdict,
        verdict_reason: result.reason,
        severity: result.severity,
        sensitive: result.sensitive ? 1 : 0,
        self_inflicted: result.selfInflicted ? 1 : 0,
        hotfix_eligible: result.hotfixEligible ? 1 : 0,
        duplicate_of: result.duplicateOf,
        project_code: result.project,
        public_title: result.publicTitle,
        public_summary: result.publicSummary,
        triaged_at: now,
        // 結果を受けた run は役目を終える (追記で仕分けへ戻ったら新しい run を起動する)。
        triage_run_id: null,
        triage_failures: 0,
        ...(to === "needs_info" ? { info_requested_at: now } : {}),
      },
      event: { kind: "triage_result", actor_kind: "ai", actor_id: input.sessionId },
    }, now);
    if (!changed) return { ok: false, error: "state_changed" };
    const updated = this.deps.ledger.find(report.id)!;
    await this.reply(updated);
    if (to === "accepted") await this.deps.onAccepted(report.id);
    return { ok: true, status: to };
  }

  /**
   * 起動済みの run を照合する。 まだ動いている・結果不明で待つべきなら false (この報告は今回は起動しない)。
   * run が結果を返さずに終わった・起動に失敗したなら失敗を数えて run を外し、true を返す。
   */
  private reconcileRun(report: BountyReportRow): boolean {
    const run = this.deps.delegation.findRun(report.triage_run_id!);
    const now = this.now();
    if (!run) {
      // 予約したが run が見えない: 起動の結果が不明。 猶予の間は増やさない。
      if (report.triage_started_at !== null && now - report.triage_started_at < LAUNCH_GRACE_MS) return false;
    } else if (!isTerminalRunStatus(run.status)) {
      return false;
    }
    this.deps.ledger.update({
      id: report.id,
      expectStatus: "received",
      patch: { triage_run_id: null, triage_failures: report.triage_failures + 1 },
      event: { kind: "triage_result", to_value: run ? `run_${run.status}_without_result` : "launch_lost", actor_kind: "system" },
    }, now);
    return true;
  }

  private async launch(report: BountyReportRow): Promise<boolean> {
    const project = report.project_code;
    const candidates = this.deps.projects.companyProjects(report.subsidiary_id) ?? this.deps.projects.registered();
    const cwd = project ? this.deps.projects.repoPath(project) : null;
    if (!project || !cwd) {
      // 作業領域が決まらない (プロジェクト不明) 報告は AI に推定させる材料が無い。 権限者へ回す。
      await this.escalate(report, "対象プロジェクトの作業領域を決められません");
      return false;
    }
    const runId = randomUUID();
    const now = this.now();
    // 先に台帳へ run id を予約する。 起動の応答が失われても、次回は run を照会してから増やす。
    const reserved = this.deps.ledger.update({
      id: report.id,
      expectStatus: "received",
      patch: { triage_run_id: runId, triage_started_at: now },
    }, now);
    if (!reserved) return false;
    const prompt = buildBountyTriagePrompt({
      reportId: report.id,
      project,
      candidateProjects: candidates,
      whatHappened: report.what_happened,
      reproSteps: report.repro_steps,
      openReports: this.deps.ledger.listOpenForProject(project, report.id, MAX_TRIAGE_OPEN_REPORTS).map((row) => ({
        id: row.id,
        summary: row.public_title ?? row.public_summary ?? row.what_happened,
      })),
      nonce: this.nonce(),
    });
    let outcome: { ok: true } | { ok: false; error: string };
    try {
      outcome = await this.deps.delegation.launch({
        runId, callName: BOUNTY_TRIAGE_CALL_NAME, cwd, project, args: { task: prompt, target_repo: cwd },
      });
    } catch (error) {
      // 結果不明。 予約を残し、次回の照合で run の有無を確かめる。
      this.deps.log?.warn(`bounty triage launch unknown report=${report.id}: ${(error as Error).message}`);
      return true;
    }
    if (!outcome.ok) {
      this.deps.ledger.update({
        id: report.id,
        expectStatus: "received",
        patch: { triage_run_id: null, triage_failures: report.triage_failures + 1 },
        event: { kind: "triage_result", to_value: "launch_failed", actor_kind: "system" },
      }, this.now());
      this.deps.log?.warn(`bounty triage launch failed report=${report.id}: ${outcome.error}`);
      return false;
    }
    this.deps.ledger.recordEvent(report.id, { kind: "triage_result", to_value: `launched:${runId}`, actor_kind: "system" }, now);
    return true;
  }

  private async escalate(report: BountyReportRow, detail?: string): Promise<void> {
    if (report.triage_escalated_at !== null) return;
    const now = this.now();
    const marked = this.deps.ledger.update({
      id: report.id,
      patch: { triage_escalated_at: now },
      event: { kind: "triage_result", to_value: "escalated", actor_kind: "system" },
    }, now);
    if (marked) await this.deps.notifier.notifyAuthority(authorityNotice("triage_escalated", report.id, detail));
  }

  private async reply(report: BountyReportRow): Promise<void> {
    const delivered = await this.deps.notifier.replyToReporter(report, triageReplyMessage(report)).catch(() => false);
    this.deps.ledger.recordEvent(report.id, {
      kind: "notified", to_value: delivered ? "triage_delivered" : "triage_failed", actor_kind: "system",
    }, this.now());
  }
}
