/**
 * 本社から配られた社員名簿の役職 (SPEC-FED-STAFF-ROLES)。
 *
 * 2026-10-12 neco「MELPOTのDiscordで権限が無いといわれるが権限はあるはず」→「本社の名簿を配る」。
 * 拠点の名簿は拠点の Discord に触れた人を「ヒラ社員」で記録するだけなので、本社で管理職の人も
 * 拠点ではセッションを終了できなかった。拠点は本社の名簿 (役職を持つ人だけ) を受け取り、
 * 自分の名簿と比べて高いほうの役職で判定する。拠点の名簿で上げた役職は下げない。
 *
 * 置き場所は拠点の schema_meta。 権限判定は複数プロセス (本体 / chat worker / Discord) の
 * StaffRepo から行うので、プロセス内のメモリではなく DB に置く。
 */
import type { StaffRole } from "./roles.js";
import { STAFF_ROLES } from "./roles.js";

export const HQ_STAFF_ROLES_KEY = "federation.site.hq_staff_roles";

export interface HqStaffRole {
  platform: "discord" | "slack";
  user_id: string;
  role: Exclude<StaffRole, "staff">;
}

function isHqStaffRole(value: unknown): value is HqStaffRole {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (row.platform === "discord" || row.platform === "slack")
    && typeof row.user_id === "string" && row.user_id.length > 0
    && (row.role === "manager" || row.role === "executive");
}

/** 保存値を読む。 壊れた値・形の違う行は捨てる (権限を与える側に倒さない)。 */
export function parseHqStaffRoles(raw: string | null | undefined): HqStaffRole[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter(isHqStaffRole) : [];
  } catch {
    return [];
  }
}

export function serializeHqStaffRoles(roles: readonly HqStaffRole[]): string {
  return JSON.stringify(roles.filter(isHqStaffRole));
}

export function hqRoleOf(roles: readonly HqStaffRole[], platform: string, userId: string): StaffRole | null {
  return roles.find((row) => row.platform === platform && row.user_id === userId)?.role ?? null;
}

/** 高いほうの役職。 どちらも無ければ null (= 未登録)。 */
export function higherRole(a: StaffRole | null, b: StaffRole | null): StaffRole | null {
  if (!a) return b;
  if (!b) return a;
  return STAFF_ROLES.indexOf(a) >= STAFF_ROLES.indexOf(b) ? a : b;
}
