/**
 * 社員名簿に基づく capability 判定の共通入口。
 *
 * Discord の操作面と HTTP API が別々に役職比較を持つと、片方だけ権限境界を
 * 変え忘れる。役職の解決と capabilityAllowed 呼び出しをここへ集約する。
 *
 * @implements spec/feature/revisor-local-pr-submission.md — 管理者の指示に基づくセッションからのマージ
 */
import type { StaffPlatform, StaffRepo } from "../db/staff-repo.js";
import {
  CAPABILITY_LABEL,
  CAPABILITY_MIN_ROLE,
  STAFF_ROLE_LABEL,
  capabilityAllowed,
  type StaffCapability,
  type StaffRole,
} from "./roles.js";

export interface StaffCapabilityAuthorization {
  allowed: boolean;
  role: StaffRole | null;
  detail: string;
}

/** 指定 platform の社員名簿を live 参照して capability を判定する。 */
export function authorizeStaffCapability(
  staff: Pick<StaffRepo, "roleOf">,
  platform: StaffPlatform,
  userId: string,
  capability: StaffCapability,
): StaffCapabilityAuthorization {
  const role = staff.roleOf(platform, userId);
  if (capabilityAllowed(role, capability)) {
    return { allowed: true, role, detail: "authorized" };
  }
  const requiredRole = CAPABILITY_MIN_ROLE[capability];
  const actualRole = role ?? "staff";
  return {
    allowed: false,
    role,
    detail: `${CAPABILITY_LABEL[capability]} requires ${STAFF_ROLE_LABEL[requiredRole]} or higher; requester role is ${STAFF_ROLE_LABEL[actualRole]}`,
  };
}
