/**
 * 部署の担当プロジェクトを所有会社の範囲に閉じる純関数。
 *
 * 子会社は関係プロジェクト (subsidiary_projects) で掲載・起動の範囲を絞っている
 * (subsidiary-delegation.md §3.4)。 その子会社の部署が範囲外のプロジェクトを担当に
 * 持てると、 部署経由で子会社の起動範囲を広げる抜け道になる。
 *
 * @implements spec/feature/departments.md §3 (CC-DEPT-INV-03)
 * @implements SPEC-DEPT-OWNERSHIP
 */

import { isProjectInDepartment } from "./launch-defaults.js";

export type DepartmentProjectsResult =
  | { ok: true }
  | { ok: false; denial: "department_projects_outside_subsidiary_scope"; outside: string[] };

/**
 * @param projects 部署の担当プロジェクト
 * @param organizationProjects 子会社の関係プロジェクト。 本社部署は null (制限なし)。
 */
export function checkDepartmentProjects(
  projects: readonly string[],
  organizationProjects: readonly string[] | null,
): DepartmentProjectsResult {
  if (organizationProjects === null) return { ok: true };
  const outside = projects.filter((project) => !isProjectInDepartment(project, organizationProjects));
  if (outside.length > 0) {
    return { ok: false, denial: "department_projects_outside_subsidiary_scope", outside };
  }
  return { ok: true };
}
