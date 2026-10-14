/**
 * バグ報告の台帳 (bounty_reports / bounty_report_events) の repository。
 * 保存・状態の CAS・照会だけを持つ。 遷移の可否と権限は src/bounty/ が決める。
 *
 * 原文 (what_happened / repro_steps) はこの表にだけ置き、 ログへ出さない
 * (spec/feature/bug-bounty.md §10)。 同じ冪等キーは 1 行 (CC-BOUNTY-INV-02)。
 * 遷移は状態が期待どおりのときだけ書き、 同じ transaction で履歴を 1 行残す (§9)。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-TRIAGE
 * @implements SPEC-BOUNTY-WEBUI
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
  triage_run_id: string | null;
  triage_started_at: number | null;
  triage_failures: number;
  triage_escalated_at: number | null;
  info_requested_at: number | null;
  appeal_requested_at: number | null;
  appeal_reason: string | null;
  appeal_decided_at: number | null;
  actio_task_attempted_at: number | null;
  hotfix_run_id: string | null;
  hotfix_started_at: number | null;
  reward_state: BountyRewardState | null;
  reward_note: string | null;
  reward_tokens: number | null;
  actio_done_notified_at: number | null;
  /** 受付時に紐付いた企画 (bounty_events)。 企画外は null。 後から付け替えない。 */
  event_id: string | null;
}

/** 報奨の依頼の結果。 付与そのものは個人の AI 予算の台帳が持つ。 */
export type BountyRewardState = "granted" | "skipped" | "revoked";

/** 一覧の 1 行。 原文 (what_happened / repro_steps) と受付口の参照を含めない (§8.2)。 */
export type BountyReportSummaryRow = Omit<BountyReportRow, "what_happened" | "repro_steps" | "intake_ref_json" | "intake_key">;

export interface BountyReportListFilter {
  status?: BountyReportStatus | null;
  project?: string | null;
  /** 会社。 本社は `""` で指定する (null / 未指定は絞らない)。 */
  company?: string | null;
  /** 企画。 企画外は `""` で指定する (null / 未指定は絞らない)。 */
  event?: string | null;
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
  /** 受付時に紐付けた企画。 企画外は null / 未指定。 */
  event_id?: string | null;
}

/** 遷移と同時に (または状態を変えずに) 書ける列。 状態そのものは `to` で渡す。 */
export interface BountyReportPatch {
  what_happened?: string;
  repro_steps?: string;
  withdrawn_at?: number | null;
  project_code?: string | null;
  verdict?: BountyVerdict | null;
  verdict_reason?: string | null;
  severity?: BountySeverity | null;
  sensitive?: number;
  self_inflicted?: number | null;
  hotfix_eligible?: number | null;
  duplicate_of?: string | null;
  public_title?: string | null;
  public_summary?: string | null;
  actio_task_ref?: string | null;
  actio_task_error?: string | null;
  actio_task_attempted_at?: number | null;
  fix_pr?: string | null;
  deploy_code?: string | null;
  deploy_hash?: string | null;
  close_evidence?: string | null;
  closed_by?: string | null;
  triaged_at?: number | null;
  deployed_at?: number | null;
  triage_run_id?: string | null;
  triage_started_at?: number | null;
  triage_failures?: number;
  triage_escalated_at?: number | null;
  info_requested_at?: number | null;
  appeal_requested_at?: number | null;
  appeal_reason?: string | null;
  appeal_decided_at?: number | null;
  hotfix_run_id?: string | null;
  hotfix_started_at?: number | null;
  reward_state?: BountyRewardState | null;
  reward_note?: string | null;
  reward_tokens?: number | null;
  actio_done_notified_at?: number | null;
}

const PATCH_COLUMNS: ReadonlyArray<keyof BountyReportPatch> = [
  "what_happened", "repro_steps", "withdrawn_at", "project_code", "verdict", "verdict_reason", "severity", "sensitive",
  "self_inflicted", "hotfix_eligible", "duplicate_of", "public_title", "public_summary", "actio_task_ref",
  "actio_task_error", "actio_task_attempted_at", "fix_pr", "deploy_code", "deploy_hash", "close_evidence", "closed_by",
  "triaged_at", "deployed_at", "triage_run_id", "triage_started_at", "triage_failures", "triage_escalated_at",
  "info_requested_at", "appeal_requested_at", "appeal_reason", "appeal_decided_at", "hotfix_run_id",
  "hotfix_started_at", "reward_state", "reward_note", "reward_tokens", "actio_done_notified_at",
];

/** 一覧で返す列 (原文・受付口を除く)。 */
const SUMMARY_COLUMNS = [
  "id", "subsidiary_id", "project_code", "reporter_kind", "reporter_id", "reporter_session_id", "recipient_reporter_id",
  "intake_platform", "status", "verdict", "verdict_reason", "severity", "sensitive", "self_inflicted", "hotfix_eligible",
  "duplicate_of", "public_title", "public_summary", "actio_task_ref", "actio_task_error", "fix_pr", "deploy_code",
  "deploy_hash", "close_evidence", "closed_by", "received_at", "triaged_at", "deployed_at", "withdrawn_at", "updated_at",
  "triage_run_id", "triage_started_at", "triage_failures", "triage_escalated_at", "info_requested_at",
  "appeal_requested_at", "appeal_reason", "appeal_decided_at", "actio_task_attempted_at", "hotfix_run_id",
  "hotfix_started_at", "reward_state", "reward_note", "reward_tokens", "actio_done_notified_at", "event_id",
].join(", ");

/** 修正を進めていて反映を待っている状態。 */
const AWAITING_DEPLOY: readonly BountyReportStatus[] = ["fix_pending", "fixing", "fix_submitted"];
/** 未解決 (重複判定の材料になる) 状態。 */
const OPEN_STATES: readonly BountyReportStatus[] = ["received", "needs_info", "accepted", "fix_pending", "fixing", "fix_submitted"];

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
          received_at, updated_at, event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.subsidiary_id, input.project_code, input.reporter_kind, input.reporter_id, input.reporter_session_id,
        input.recipient_reporter_id, input.what_happened, input.repro_steps, input.intake_platform, input.intake_key,
        input.intake_ref_json, input.status, now, now, input.event_id ?? null,
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

  /**
   * 状態を変えずに列を書く。 `expectStatus` を渡すと、その状態のときだけ書く (CAS)。
   * `event` を渡すと同じ transaction で履歴を 1 行残す。 書けなかったら false。
   */
  update(input: {
    id: string;
    patch: BountyReportPatch;
    expectStatus?: BountyReportStatus;
    event?: BountyReportEventInput;
  }, now: number = Date.now()): boolean {
    return this.db.transaction((): boolean => {
      const columns = PATCH_COLUMNS.filter((column) => input.patch[column] !== undefined);
      const assignments = ["updated_at = ?", ...columns.map((column) => `${column} = ?`)];
      const where = input.expectStatus ? "id = ? AND status = ?" : "id = ?";
      const params: unknown[] = [now, ...columns.map((column) => input.patch[column] ?? null), input.id];
      if (input.expectStatus) params.push(input.expectStatus);
      const changed = this.db.prepare(`UPDATE bounty_reports SET ${assignments.join(", ")} WHERE ${where}`)
        .run(...params).changes > 0;
      if (changed && input.event) this.insertEvent(input.id, input.event, now);
      return changed;
    }).immediate();
  }

  /** 管理面の一覧 (原文なし)。 新しい順。 */
  list(filter: BountyReportListFilter, limit: number, offset: number): { rows: BountyReportSummaryRow[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.project) { where.push("project_code = ?"); params.push(filter.project); }
    if (filter.company !== undefined && filter.company !== null) {
      if (filter.company === "") where.push("subsidiary_id IS NULL");
      else { where.push("subsidiary_id = ?"); params.push(filter.company); }
    }
    if (filter.event !== undefined && filter.event !== null) {
      if (filter.event === "") where.push("event_id IS NULL");
      else { where.push("event_id = ?"); params.push(filter.event); }
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM bounty_reports ${clause}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM bounty_reports ${clause} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as BountyReportSummaryRow[];
    return { rows, total };
  }

  /** 状態で引く (定期の処理用)。 古い順。 */
  listByStatus(statuses: readonly BountyReportStatus[], limit: number): BountyReportRow[] {
    if (statuses.length === 0) return [];
    return this.db.prepare(
      `SELECT * FROM bounty_reports WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY received_at, id LIMIT ?`,
    ).all(...statuses, limit) as BountyReportRow[];
  }

  /** 同じプロジェクトの未解決の報告 (重複判定の材料)。 根の報告だけ。 */
  listOpenForProject(project: string | null, excludeId: string, limit: number): BountyReportRow[] {
    const projectClause = project === null ? "project_code IS NULL" : "project_code = ?";
    const params: unknown[] = project === null ? [] : [project];
    return this.db.prepare(
      `SELECT * FROM bounty_reports WHERE ${projectClause} AND id <> ? AND duplicate_of IS NULL
       AND status IN (${OPEN_STATES.map(() => "?").join(", ")}) ORDER BY received_at DESC LIMIT ?`,
    ).all(...params, excludeId, ...OPEN_STATES, limit) as BountyReportRow[];
  }

  /** そのプロジェクトで `since` 以降に起動した hotfix の数。 */
  countHotfixesSince(project: string, since: number): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS n FROM bounty_reports WHERE project_code = ? AND hotfix_started_at >= ?",
    ).get(project, since) as { n: number }).n;
  }

  /** 反映を待つ報告のうち、修正の PR が `prs` のどれかに当たるもの。 */
  listAwaitingDeployByFixPr(project: string, prs: readonly string[]): BountyReportRow[] {
    if (prs.length === 0) return [];
    return this.db.prepare(
      `SELECT * FROM bounty_reports WHERE project_code = ? AND fix_pr IN (${prs.map(() => "?").join(", ")})
       AND status IN (${AWAITING_DEPLOY.map(() => "?").join(", ")}) ORDER BY received_at`,
    ).all(project, ...prs, ...AWAITING_DEPLOY) as BountyReportRow[];
  }

  /** 公開候補 (採用済み) の報告。 公開してよいかは呼び出し側が純関数で決める。 */
  listAcceptedForProject(project: string, limit: number): BountyReportSummaryRow[] {
    return this.db.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM bounty_reports WHERE project_code = ? AND verdict = ?
       ORDER BY received_at DESC LIMIT ?`,
    ).all(project, "accepted", limit) as BountyReportSummaryRow[];
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
