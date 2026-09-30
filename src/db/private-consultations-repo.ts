/**
 * プライベート相談 (private_consultations / private_consultation_members) の repository。
 * 保存と照会だけを持つ。 状態遷移と権限の判定は src/consultation/ の service が持つ。
 *
 * ヒアリング (intake_json) は承認前の起動待ちにだけ使い、 ログへ出さない (CC-CONSULT-INV-05)。
 *
 * @implements SPEC-CONSULT-PRIVATE
 * @implements SPEC-CONSULT-MEMBERS
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type PrivateConsultationStatus = "pending_approval" | "open" | "closed";
export type PrivateConsultationMemberReason = "requester" | "approver" | "invited";

export interface PrivateConsultationRow {
  id: string;
  subsidiary_id: string | null;
  department_id: string;
  requester_user_id: string;
  channel_id: string | null;
  session_id: string | null;
  status: PrivateConsultationStatus;
  intake_json: string;
  approved_by: string | null;
  approved_at: number | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PrivateConsultationMemberRow {
  consultation_id: string;
  platform_user_id: string;
  reason: PrivateConsultationMemberReason;
  added_by: string;
  added_at: number;
  removed_at: number | null;
}

export interface PrivateConsultationCreateInput {
  subsidiary_id: string | null;
  department_id: string;
  requester_user_id: string;
  status: Exclude<PrivateConsultationStatus, "closed">;
  intake_json: string;
}

export class PrivateConsultationsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: PrivateConsultationCreateInput, now: number = Date.now()): PrivateConsultationRow {
    const id = `pc_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO private_consultations(id, subsidiary_id, department_id, requester_user_id, channel_id, session_id,
        status, intake_json, approved_by, approved_at, closed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(id, input.subsidiary_id, input.department_id, input.requester_user_id, input.status, input.intake_json, now, now);
    return this.find(id)!;
  }

  find(id: string): PrivateConsultationRow | null {
    return (this.db.prepare("SELECT * FROM private_consultations WHERE id = ?").get(id) as PrivateConsultationRow | undefined)
      ?? null;
  }

  findByChannel(channelId: string): PrivateConsultationRow | null {
    return (this.db.prepare("SELECT * FROM private_consultations WHERE channel_id = ?").get(channelId) as
      PrivateConsultationRow | undefined) ?? null;
  }

  findBySession(sessionId: string): PrivateConsultationRow | null {
    return (this.db.prepare(
      "SELECT * FROM private_consultations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sessionId) as PrivateConsultationRow | undefined) ?? null;
  }

  setChannel(id: string, channelId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE private_consultations SET channel_id = ?, updated_at = ? WHERE id = ?").run(channelId, now, id);
  }

  /** 承認 (または起動権限を持つ本人の開始) で open にする。 既に open / closed なら変えない。 */
  markOpen(id: string, approvedBy: string, now: number = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE private_consultations SET status = 'open', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_approval'
    `).run(approvedBy, now, now, id).changes > 0;
  }

  setSession(id: string, sessionId: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE private_consultations SET session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, now, id);
  }

  /** 閉じる (冪等)。 実際に閉じたときだけ true。 */
  markClosed(id: string, now: number = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE private_consultations SET status = 'closed', closed_at = ?, updated_at = ?
      WHERE id = ? AND status != 'closed'
    `).run(now, now, id).changes > 0;
  }

  /** 閲覧者を加える。 除外済みの人を加え直したら理由と時刻を更新する。 */
  addMember(input: Omit<PrivateConsultationMemberRow, "added_at" | "removed_at">, now: number = Date.now()): void {
    this.db.prepare(`
      INSERT INTO private_consultation_members(consultation_id, platform_user_id, reason, added_by, added_at, removed_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(consultation_id, platform_user_id) DO UPDATE SET
        reason = CASE WHEN private_consultation_members.removed_at IS NULL
          THEN private_consultation_members.reason ELSE excluded.reason END,
        added_by = CASE WHEN private_consultation_members.removed_at IS NULL
          THEN private_consultation_members.added_by ELSE excluded.added_by END,
        added_at = CASE WHEN private_consultation_members.removed_at IS NULL
          THEN private_consultation_members.added_at ELSE excluded.added_at END,
        removed_at = NULL
    `).run(input.consultation_id, input.platform_user_id, input.reason, input.added_by, now);
  }

  removeMember(consultationId: string, userId: string, now: number = Date.now()): boolean {
    return this.db.prepare(`
      UPDATE private_consultation_members SET removed_at = ?
      WHERE consultation_id = ? AND platform_user_id = ? AND removed_at IS NULL
    `).run(now, consultationId, userId).changes > 0;
  }

  /** 現在の閲覧者 (除外済みを除く)。 */
  members(consultationId: string): PrivateConsultationMemberRow[] {
    return this.db.prepare(`
      SELECT * FROM private_consultation_members WHERE consultation_id = ? AND removed_at IS NULL
      ORDER BY added_at, platform_user_id
    `).all(consultationId) as PrivateConsultationMemberRow[];
  }
}
