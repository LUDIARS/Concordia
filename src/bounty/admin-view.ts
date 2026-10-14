/**
 * 管理面 (WebUI) に出す報告の形 (spec/feature/bug-bounty.md §8.2)。 純関数。
 *
 * 一覧は原文と履歴を含めない (一覧の肥大で取得が失敗した Revisor の事例を繰り返さない)。
 * 詳細は運用担当の管理面だけに出すもので、原文・仕分けの根拠・履歴・Actio タスク・PR・反映の証拠を持つ。
 *
 * @implements SPEC-BOUNTY-WEBUI
 */

import type {
  BountyReportEventRow,
  BountyReportRow,
  BountyReportSummaryRow,
} from "../db/bounty-reports-repo.js";
import type { BountyReporterRow } from "../db/bounty-reporters-repo.js";
import { displayPublicName } from "./reporter.js";

export interface BountyAdminSummary {
  id: string;
  status: string;
  project: string | null;
  company: string | null;
  severity: string | null;
  verdict: string | null;
  reporter: string;
  recipient: string | null;
  actio_task_ref: string | null;
  actio_task_error: string | null;
  fix_pr: string | null;
  deployed_at: number | null;
  received_at: number;
  public_title: string | null;
  needs_attention: string | null;
  /** 受付時に紐付いた企画 (§18.2)。 企画外は null。 */
  event_id: string | null;
}

export interface BountyAdminDetail extends BountyAdminSummary {
  what_happened: string;
  repro_steps: string;
  intake_platform: string;
  verdict_reason: string | null;
  sensitive: boolean;
  self_inflicted: boolean | null;
  hotfix_eligible: boolean | null;
  duplicate_of: string | null;
  public_summary: string | null;
  deploy: { code: string | null; hash: string | null; evidence: string | null; closed_by: string | null };
  triage: { run_id: string | null; failures: number; escalated_at: number | null; triaged_at: number | null };
  appeal: { requested_at: number | null; reason: string | null; decided_at: number | null };
  hotfix: { run_id: string | null; started_at: number | null };
  reward: { state: string | null; tokens: number | null; note: string | null };
  events: BountyReportEventRow[];
}

type ReporterFinder = (id: string) => BountyReporterRow | null;

function personLabel(row: BountyReporterRow | null): string | null {
  if (!row) return null;
  const name = displayPublicName({ kind: "person", publicName: row.public_name });
  return `${name} (${row.platform}:${row.platform_user_id}${row.subsidiary_id ? ` @${row.subsidiary_id}` : " @本社"})`;
}

/** 人の手が要る状態の短い説明。 なければ null。 */
export function bountyAttention(row: Pick<BountyReportSummaryRow,
  "triage_escalated_at" | "appeal_requested_at" | "appeal_decided_at" | "actio_task_error" | "status">): string | null {
  if (row.appeal_requested_at !== null && row.appeal_decided_at === null) return "再審の決定待ち";
  if (row.triage_escalated_at !== null && row.status === "received") return "仕分けの失敗 (権限者の判定待ち)";
  if (row.actio_task_error && row.status === "accepted") return "Actio タスク作成の失敗";
  return null;
}

export function toBountyAdminSummary(row: BountyReportSummaryRow, find: ReporterFinder): BountyAdminSummary {
  const reporterRow = row.reporter_id ? find(row.reporter_id) : null;
  const recipientRow = row.recipient_reporter_id ? find(row.recipient_reporter_id) : null;
  return {
    id: row.id,
    status: row.status,
    project: row.project_code,
    company: row.subsidiary_id,
    severity: row.severity,
    verdict: row.verdict,
    reporter: row.reporter_kind === "session"
      ? `セッション ${row.reporter_session_id ?? "?"}`
      : personLabel(reporterRow) ?? "(不明)",
    recipient: personLabel(recipientRow),
    actio_task_ref: row.actio_task_ref,
    actio_task_error: row.actio_task_error,
    fix_pr: row.fix_pr,
    deployed_at: row.deployed_at,
    received_at: row.received_at,
    public_title: row.public_title,
    needs_attention: bountyAttention(row),
    event_id: row.event_id,
  };
}

export function toBountyAdminDetail(row: BountyReportRow, events: BountyReportEventRow[], find: ReporterFinder): BountyAdminDetail {
  return {
    ...toBountyAdminSummary(row, find),
    what_happened: row.what_happened,
    repro_steps: row.repro_steps,
    intake_platform: row.intake_platform,
    verdict_reason: row.verdict_reason,
    sensitive: row.sensitive === 1,
    self_inflicted: row.self_inflicted === null ? null : row.self_inflicted === 1,
    hotfix_eligible: row.hotfix_eligible === null ? null : row.hotfix_eligible === 1,
    duplicate_of: row.duplicate_of,
    public_summary: row.public_summary,
    deploy: { code: row.deploy_code, hash: row.deploy_hash, evidence: row.close_evidence, closed_by: row.closed_by },
    triage: { run_id: row.triage_run_id, failures: row.triage_failures, escalated_at: row.triage_escalated_at, triaged_at: row.triaged_at },
    appeal: { requested_at: row.appeal_requested_at, reason: row.appeal_reason, decided_at: row.appeal_decided_at },
    hotfix: { run_id: row.hotfix_run_id, started_at: row.hotfix_started_at },
    reward: { state: row.reward_state, tokens: row.reward_tokens, note: row.reward_note },
    events,
  };
}
