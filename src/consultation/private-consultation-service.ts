/**
 * プライベート相談のユースケース (application)。 部署の検査・閲覧者の決定・承認・招待・終了を持つ。
 * Discord のチャンネル操作は呼び出し側 (src/discord/consult-*) が、 ここが返した閲覧者の集合どおりに行う。
 *
 * - 対象は本社の、 プライベート相談を許可した稼働中の部署だけ (tech-consultation.md §4)。
 * - 閲覧者 = 本人 + 社員名簿で部署の approver_min_role 以上の人。 以後の追加・除外は本人か権限者だけ
 *   (CC-CONSULT-INV-02)。 本人は除外できない。
 * - 本人が起動権限を持てばそのまま open、 持たなければ承認待ち。 承認できるのは起動権限を持つ閲覧者。
 *
 * @implements SPEC-CONSULT-PRIVATE
 * @implements SPEC-CONSULT-MEMBERS
 * @implements SPEC-CONSULT-CLOSE
 */

import type { DepartmentRow } from "../db/departments-repo.js";
import type {
  PrivateConsultationMemberReason,
  PrivateConsultationMemberRow,
  PrivateConsultationRow,
  PrivateConsultationsRepo,
} from "../db/private-consultations-repo.js";
import { parseDepartmentSettings, type DepartmentPrivateConsultation } from "../departments/settings.js";
import { isConsultIntakeComplete, normalizeConsultIntake, type ConsultIntake } from "../dialogue/intake.js";

export type PrivateConsultationStore = Pick<PrivateConsultationsRepo,
  "create" | "find" | "findByChannel" | "findBySession" | "setChannel" | "markOpen" | "setSession" | "markClosed"
  | "addMember" | "removeMember" | "members">;

export interface PrivateConsultationPorts {
  store: PrivateConsultationStore;
  department(id: string): DepartmentRow | null;
  /** 社員名簿で role 以上の Discord ユーザー。 */
  approvers(minRole: DepartmentPrivateConsultation["approver_min_role"]): readonly string[];
  /** 起動権限 (社員名簿の session_spawn)。 */
  canLaunch(userId: string): boolean;
  now?: () => number;
}

export type PrivateConsultationError =
  | "department_not_found"
  | "department_archived"
  | "department_not_private"
  | "head_office_only"
  | "department_settings_invalid"
  | "intake_incomplete"
  | "consultation_not_found"
  | "consultation_closed"
  | "not_pending_approval"
  | "not_allowed"
  | "cannot_remove_requester";

export type Result<T> = { ok: true } & T | { ok: false; error: PrivateConsultationError };

export interface StartedConsultation {
  consultation: PrivateConsultationRow;
  members: PrivateConsultationMemberRow[];
  /** 本人に起動権限が無く、 権限者の承認を待つ。 */
  needsApproval: boolean;
}

export class PrivateConsultationService {
  private readonly now: () => number;

  constructor(private readonly ports: PrivateConsultationPorts) {
    this.now = ports.now ?? Date.now;
  }

  /** `/consult start` の受付。 チャンネルを作る前に部署と閲覧者を確定する。 */
  start(input: {
    departmentId: string;
    /** この Bot (論理 runtime) の会社。 本社なら null。 */
    runtimeSubsidiaryId: string | null;
    requesterUserId: string;
    intake: Partial<Record<keyof ConsultIntake, unknown>>;
  }): Result<StartedConsultation> {
    const checked = this.privateDepartment(input.departmentId, input.runtimeSubsidiaryId);
    if (!checked.ok) return checked;
    const intake = normalizeConsultIntake(input.intake);
    if (!isConsultIntakeComplete(intake)) return { ok: false, error: "intake_incomplete" };
    const now = this.now();
    const launchable = this.ports.canLaunch(input.requesterUserId);
    // いったん承認待ちで作り、 本人が起動権限を持てば本人の承認として開く (承認者と時刻を必ず残す)。
    const consultation = this.ports.store.create({
      subsidiary_id: null,
      department_id: checked.department.id,
      requester_user_id: input.requesterUserId,
      status: "pending_approval",
      intake_json: JSON.stringify(intake),
    }, now);
    if (launchable) this.ports.store.markOpen(consultation.id, input.requesterUserId, now);
    this.addMember(consultation.id, input.requesterUserId, "requester", input.requesterUserId, now);
    for (const approver of this.ports.approvers(checked.settings.approver_min_role)) {
      if (approver !== input.requesterUserId) this.addMember(consultation.id, approver, "approver", "system", now);
    }
    return {
      ok: true,
      consultation: this.ports.store.find(consultation.id)!,
      members: this.ports.store.members(consultation.id),
      needsApproval: !launchable,
    };
  }

  /** 承認待ちの相談を、 起動権限を持つ閲覧者が承認する。 */
  approve(consultationId: string, approverUserId: string): Result<{ consultation: PrivateConsultationRow }> {
    const consultation = this.ports.store.find(consultationId);
    if (!consultation) return { ok: false, error: "consultation_not_found" };
    if (consultation.status !== "pending_approval") return { ok: false, error: "not_pending_approval" };
    const isMember = this.ports.store.members(consultationId).some((m) => m.platform_user_id === approverUserId);
    if (!isMember || !this.ports.canLaunch(approverUserId)) return { ok: false, error: "not_allowed" };
    if (!this.ports.store.markOpen(consultationId, approverUserId, this.now())) {
      return { ok: false, error: "not_pending_approval" };
    }
    return { ok: true, consultation: this.ports.store.find(consultationId)! };
  }

  invite(consultationId: string, actorUserId: string, targetUserId: string): Result<{ member: PrivateConsultationMemberRow }> {
    const allowed = this.memberAction(consultationId, actorUserId);
    if (!allowed.ok) return allowed;
    this.addMember(consultationId, targetUserId, "invited", actorUserId, this.now());
    const member = this.ports.store.members(consultationId).find((m) => m.platform_user_id === targetUserId)!;
    return { ok: true, member };
  }

  remove(consultationId: string, actorUserId: string, targetUserId: string): Result<{ removed: boolean }> {
    const allowed = this.memberAction(consultationId, actorUserId);
    if (!allowed.ok) return allowed;
    if (targetUserId === allowed.consultation.requester_user_id) return { ok: false, error: "cannot_remove_requester" };
    return { ok: true, removed: this.ports.store.removeMember(consultationId, targetUserId, this.now()) };
  }

  /** セッションの終了・消失、 またはチャンネルの喪失で閉じる (冪等)。 */
  close(consultationId: string): boolean {
    return this.ports.store.markClosed(consultationId, this.now());
  }

  /** 承認前に預かったヒアリング。 */
  intakeOf(consultation: PrivateConsultationRow): ConsultIntake {
    try {
      return normalizeConsultIntake(JSON.parse(consultation.intake_json) as Record<string, unknown>);
    } catch {
      // 自分で書いた JSON なので壊れていることは想定しないが、 起動を止めずに空の前提で扱う。
      return normalizeConsultIntake({});
    }
  }

  private privateDepartment(departmentId: string, runtimeSubsidiaryId: string | null):
    | { ok: true; department: DepartmentRow; settings: DepartmentPrivateConsultation }
    | { ok: false; error: PrivateConsultationError } {
    const department = this.ports.department(departmentId);
    if (!department) return { ok: false, error: "department_not_found" };
    // 子会社のセッションは関係プロジェクトで起動範囲を閉じるため、 相談は本社の部署だけで受ける。
    if (department.subsidiary_id !== null || runtimeSubsidiaryId !== null) return { ok: false, error: "head_office_only" };
    if (department.archived_at !== null) return { ok: false, error: "department_archived" };
    let settings: DepartmentPrivateConsultation;
    try {
      settings = parseDepartmentSettings(department.settings_json).private;
    } catch {
      return { ok: false, error: "department_settings_invalid" };
    }
    if (!settings.enabled) return { ok: false, error: "department_not_private" };
    return { ok: true, department, settings };
  }

  private memberAction(consultationId: string, actorUserId: string):
    | { ok: true; consultation: PrivateConsultationRow }
    | { ok: false; error: PrivateConsultationError } {
    const consultation = this.ports.store.find(consultationId);
    if (!consultation) return { ok: false, error: "consultation_not_found" };
    if (consultation.status === "closed") return { ok: false, error: "consultation_closed" };
    const actor = this.ports.store.members(consultationId).find((m) => m.platform_user_id === actorUserId);
    if (!actor || (actor.reason !== "requester" && actor.reason !== "approver")) return { ok: false, error: "not_allowed" };
    return { ok: true, consultation };
  }

  private addMember(
    consultationId: string,
    userId: string,
    reason: PrivateConsultationMemberReason,
    addedBy: string,
    now: number,
  ): void {
    this.ports.store.addMember({ consultation_id: consultationId, platform_user_id: userId, reason, added_by: addedBy }, now);
  }
}
