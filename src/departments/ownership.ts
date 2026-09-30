/**
 * 部署の所有境界の判断。 起動・委託が指定した部署を、 起動する会社と
 * チームに照らして使ってよいかを決める純関数だけを置く。
 *
 * 会社 (本社 = null / 子会社 id) をまたいで部署を使えると、 子会社のセッションに
 * 本社部署のルールや担当プロジェクトが混ざり、 組織の可視境界 (CC-INV-02) が崩れる。
 *
 * @implements spec/feature/departments.md §3 (CC-DEPT-INV-02 / 06 / 07)
 * @implements SPEC-DEPT-OWNERSHIP
 */

export interface DepartmentOwnershipView {
  id: string;
  /** 所有する子会社。 null は本社部署。 */
  subsidiary_id: string | null;
  /** 廃止した時刻 (epoch-ms)。 null = 稼働中。 */
  archived_at: number | null;
}

export type DepartmentOwnershipDenial =
  | "department_archived"
  | "department_not_owned_by_requested_organization";

export type DepartmentOwnershipResult = { ok: true } | { ok: false; denial: DepartmentOwnershipDenial };

/**
 * 起動する会社 (`organizationId`、 本社は null) がこの部署を使えるか。
 * 廃止済みの部署からは新しく起動しない (既存セッションの所属は残す)。
 */
export function checkDepartmentOwnership(
  department: DepartmentOwnershipView,
  organizationId: string | null,
): DepartmentOwnershipResult {
  if (department.archived_at !== null) return { ok: false, denial: "department_archived" };
  if ((department.subsidiary_id ?? null) !== (organizationId ?? null)) {
    return { ok: false, denial: "department_not_owned_by_requested_organization" };
  }
  return { ok: true };
}

export type TeamDepartmentResult =
  | { ok: true; departmentId: string | null }
  | { ok: false; denial: "team_department_mismatch" };

/**
 * 指定チームの所属部署と、 要求された部署を突き合わせて実効部署を決める。
 *
 * - チームが部署に属し、 部署が未指定なら、 チームの部署を採る (チーム起点の起動で
 *   部署の段から漏れないように)。
 * - 両方が指定されて食い違えば拒否する。 どちらかを黙って優先すると、 ルールと
 *   既定値の出どころが利用者の意図と変わる。
 */
export function reconcileTeamDepartment(
  teamDepartmentId: string | null,
  requestedDepartmentId: string | null,
): TeamDepartmentResult {
  if (!teamDepartmentId) return { ok: true, departmentId: requestedDepartmentId };
  if (!requestedDepartmentId) return { ok: true, departmentId: teamDepartmentId };
  if (teamDepartmentId !== requestedDepartmentId) return { ok: false, denial: "team_department_mismatch" };
  return { ok: true, departmentId: requestedDepartmentId };
}
