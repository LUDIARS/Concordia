/**
 * 起動・委託の入口で「どの部署として起動するか」を確定するユースケース。
 *
 * 順序: チームの所属部署との照合 → 部署の読出し → 所有会社・廃止の検証 →
 * (起動経路なら) 起動既定値の適用。 部署未指定かつチームも部署に属さない場合は
 * 未配属として要求をそのまま返す (CC-DEPT-INV-08)。
 *
 * @implements spec/feature/departments.md §3 / §5
 * @implements SPEC-DEPT-OWNERSHIP
 * @implements SPEC-DEPT-LAUNCH
 * @implements SPEC-DEPT-DEFAULT
 */

import type { DepartmentRow } from "../db/departments-repo.js";
import { applyDepartmentLaunchDefaults, type DepartmentLaunchDenial, type DepartmentLaunchRequest, type ResolvedDepartmentLaunch } from "./launch-defaults.js";
import { checkDepartmentOwnership, reconcileTeamDepartment, type DepartmentOwnershipDenial } from "./ownership.js";
import { parseDepartmentSettings } from "./settings.js";

export interface DepartmentLookupPort {
  find(id: string): DepartmentRow | null;
  /** 会社の稼働中の既定部署 (spec/feature/departments.md §9.2)。 */
  findDefault?(subsidiaryId: string | null): DepartmentRow | null;
}

export interface DepartmentLaunchInput {
  /** 要求された部署 id。 未指定は null。 */
  departmentId: string | null;
  /** 起動する会社。 本社は null。 */
  organizationId: string | null;
  /** 要求されたチームの所属部署。 チーム未指定・無所属は null。 */
  teamDepartmentId: string | null;
  request: DepartmentLaunchRequest;
  /**
   * 起動既定値を当てるか。 委託 (テンプレートが起動値を持つ) では false にして、
   * 所有と廃止の検証だけを行う。
   */
  applyDefaults: boolean;
  /**
   * 部署もチームの部署も無いとき、 会社の既定部署に入れるか。 起動 (spawn) だけが true。
   * 委託は親の作業の一部なので既定部署に入れない。
   */
  useOrganizationDefault?: boolean;
}

export type DepartmentLaunchError =
  | "department_not_found"
  | "department_settings_invalid"
  | "team_department_mismatch"
  | DepartmentOwnershipDenial
  | DepartmentLaunchDenial;

export type DepartmentLaunchResolution =
  | { ok: true; department: DepartmentRow | null; launch: ResolvedDepartmentLaunch }
  | { ok: false; error: DepartmentLaunchError };

export function resolveDepartmentLaunch(
  departments: DepartmentLookupPort,
  input: DepartmentLaunchInput,
): DepartmentLaunchResolution {
  const reconciled = reconcileTeamDepartment(input.teamDepartmentId, input.departmentId);
  if (!reconciled.ok) return { ok: false, error: reconciled.denial };
  const passthrough = asResolved(input.request);
  const department = reconciled.departmentId
    ? departments.find(reconciled.departmentId)
    : input.useOrganizationDefault ? departments.findDefault?.(input.organizationId) ?? null : null;
  if (!reconciled.departmentId && !department) return { ok: true, department: null, launch: passthrough };
  if (!department) return { ok: false, error: "department_not_found" };
  const ownership = checkDepartmentOwnership(department, input.organizationId);
  if (!ownership.ok) return { ok: false, error: ownership.denial };
  if (!input.applyDefaults) return { ok: true, department, launch: passthrough };

  let settings;
  try {
    settings = parseDepartmentSettings(department.settings_json);
  } catch {
    // 保存時に検証しているので、 ここへ来るのは DB を直接書き換えた場合だけ。
    // 既定値も範囲制限も効かないまま起動させない。
    return { ok: false, error: "department_settings_invalid" };
  }
  const applied = applyDepartmentLaunchDefaults(input.request, settings);
  if (!applied.ok) return { ok: false, error: applied.denial };
  return { ok: true, department, launch: applied.launch };
}

function asResolved(request: DepartmentLaunchRequest): ResolvedDepartmentLaunch {
  return {
    template: request.template ?? null,
    provider: request.provider ?? null,
    model: request.model ?? null,
    reasoning_effort: request.reasoning_effort ?? null,
    project: request.project ?? null,
    cwd: request.cwd ?? null,
  };
}
