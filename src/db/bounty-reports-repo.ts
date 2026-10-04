/**
 * バグ報告の台帳 (bounty_reports / bounty_report_events) の repository。
 * 保存・状態の CAS・照会だけを持つ。 遷移の可否と権限は src/bounty/ が決める。
 *
 * 原文 (what_happened / repro_steps) はこの表にだけ置き、 ログへ出さない
 * (spec/feature/bug-bounty.md §10)。 同じ冪等キーは 1 行 (CC-BOUNTY-INV-02)。
 * 遷移は状態が期待どおりのときだけ書き、 同じ transaction で履歴を 1 行残す (§9)。
 *
 * @implements SPEC-BOUNTY-INTAKE
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BountyIntakePlatform } from "../bounty/intake.js";
import type { BountyReportStatus } from "../bounty/report-state.js";

export type BountyReporterKind = "person" | "session";
export type BountyVerdict = "accepted" | "duplicate" | "rejected" | "needs_info";
export type BountySeverity = "s1" | "s2" | "s3" | "s4";
export type BountyEventActorKind = "ai" | "human" | "system";

/** 履歴の種別 (§10)。 追記と取り下げは受付側の遷移として記録する。 */
export type BountyReportEventKind =
  | "received"
  | "amended"
  | "withdrawn"
  | "triage_result"
  | "verdict_changed"
  | "appeal"
  | "task_created"
  | "hotfix_started"
  | "pr_recorded"
  | "deployed"
  | "reward"
  | "notified";

export interface BountyReportRow {
  id: string;
  subsidiary_id: string | null;
  project_code: string | null;
  reporter_kind: BountyReporterKind;
  reporter_id: string | null;
  reporter_session_id: string | null;
  recipient_reporter_id: string | null;
  what_happened: string;
  repro_steps: string;
  intake_platform: BountyIntakePlatform;
  intake_key: string;
  intake_ref_json: string;
  status: BountyReportStatus;
  verdict: BountyVerdict | null;
  verdict_reason: string | null;
  severity: BountySeverity | null;
  /** 反映まで公開面に出さないか。 仕分けが決めるまでは 1 (機微) として扱う。 */
  sensitive: number;
  self_inflicted: number | null;
  hotfix_eligible: number | null;
  duplicate_of: string | null;
  public_title: string | null;
  public_summary: string | null;
  actio_task_ref: string | null;
  actio_task_error: string | null;
  fix_pr: string | null;
  deploy_code: string | null;
  deploy_hash: string | null;
  close_evidence: string | null;
  closed_by: string | null;
  received_at: number;
  triaged_at: number | null;
  deployed_at: number | null;
  withdrawn_at: number | null;
  updated_at: number;
}

export interface BountyReportEventRow {
  id: number;
  report_id: string;
  kind: BountyReportEventKind;
  from_value: string | null;
  to_value: string | null;
  actor_kind: BountyEventActorKind;
  actor_id: string | null;
  created_at: number;
}

export interface BountyReportEventInput {
  kind: BountyReportEventKind;
  from_value?: string | null;
  to_value?: string | null;
  actor_kind: BountyEventActorKind;
  actor_id?: string | null;
}

export interface BountyReportCreateInput {
  subsidiary_id: string | null;
  project_code: string | null;
  reporter_kind: BountyReporterKind;
  reporter_id: string | null;
  reporter_session_id: string | null;
  recipient_reporter_id: string | null;
  what_happened: string;
  repro_steps: string;
  intake_platform: BountyIntakePlatform;
  intake_key: string;
  intake_ref_json: string;
  status: Extract<BountyReportStatus, "received" | "needs_info">;
}

/** 遷移と同時に書ける列。 状態そのものは `to` で渡す。 */
export interface BountyReportPatch {
  what_happened?: string;
  repro_steps?: string;
  withdrawn_at?: number | null;
}

const PATCH_COLUMNS: ReadonlyArray<keyof BountyReportPatch> = ["what_happened", "repro_steps", "withdrawn_at"];

export class BountyReportsRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * 報告を 1 行書き、 受付の履歴を残す。 同じ冪等キーが既にあれば何も書かず既存の行を返す
   * (`created: false`)。 検査と INSERT は 1 transaction に閉じる。
   */
  create(
    input: BountyReportCreateInput,
    event: Omit<BountyReportEventInput, "kind" | "from_value" | "to_value">,
    now: number = Date.now(),
  ): { row: BountyReportRow; created: boolean } {
    return this.db.transaction((): { row: BountyReportRow; created: boolean } => {
      const existing = this.findByIntakeKey(input.intake_key);
      if (existing) return { row: existing, created: false };
      const id = `br_${randomUUID().replace(/-/g, "")}`;
      this.db.prepare(`
        INSERT INTO bounty_reports(id, subsidiary_id, project_code, reporter_kind, reporter_id, reporter_session_id,
          recipient_reporter_id, what_happened, repro_steps, intake_platform, intake_key, intake_ref_json, status,
          received_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.subsidiary_id, input.project_code, input.reporter_kind, input.reporter_id, input.reporter_session_id,
        input.recipient_reporter_id, input.what_happened, input.repro_steps, input.intake_platform, input.intake_key,
        input.intake_ref_json, input.status, now, now,
      );
      this.insertEvent(id, { ...event, kind: "received", from_value: null, to_value: input.status }, now);
      return { row: this.find(id)!, created: true };
    }).immediate();
  }

  find(id: string): BountyReportRow | null {
    return (this.db.prepare("SELECT * FROM bounty_reports WHERE id = ?").get(id) as BountyReportRow | undefined) ?? null;
  }

  findByIntakeKey(intakeKey: string): BountyReportRow | null {
    return (this.db.prepare("SELECT * FROM bounty_reports WHERE intake_key = ?").get(intakeKey) as
      BountyReportRow | undefined) ?? null;
  }

  /**
   * 状態を `from` から `to` へ進める。 現在の状態が `from` のときだけ書き (CAS)、 書けたら同じ
   * transaction で履歴を 1 行残す。 書けなかった (他の遷移が先に入った) ら false。
   */
  transition(input: {
    id: string;
    from: BountyReportStatus;
    to: BountyReportStatus;
    patch?: BountyReportPatch;
    event: Omit<BountyReportEventInput, "from_value" | "to_value">;
  }, now: number = Date.now()): boolean {
    return this.db.transaction((): boolean => {
      const columns = PATCH_COLUMNS.filter((column) => input.patch?.[column] !== undefined);
      const assignments = ["status = ?", "updated_at = ?", ...columns.map((column) => `${column} = ?`)];
      const changed = this.db.prepare(
        `UPDATE bounty_reports SET ${assignments.join(", ")} WHERE id = ? AND status = ?`,
      ).run(input.to, now, ...columns.map((column) => input.patch![column] ?? null), input.id, input.from).changes > 0;
      if (!changed) return false;
      this.insertEvent(input.id, { ...input.event, from_value: input.from, to_value: input.to }, now);
      return true;
    }).immediate();
  }

  /** 状態を変えない出来事 (通知など) の履歴。 */
  recordEvent(reportId: string, event: BountyReportEventInput, now: number = Date.now()): void {
    this.insertEvent(reportId, event, now);
  }

  events(reportId: string): BountyReportEventRow[] {
    return this.db.prepare("SELECT * FROM bounty_report_events WHERE report_id = ? ORDER BY id")
      .all(reportId) as BountyReportEventRow[];
  }

  private insertEvent(reportId: string, event: BountyReportEventInput, now: number): void {
    this.db.prepare(`
      INSERT INTO bounty_report_events(report_id, kind, from_value, to_value, actor_kind, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reportId, event.kind, event.from_value ?? null, event.to_value ?? null, event.actor_kind,
      event.actor_id ?? null, now);
  }
}
