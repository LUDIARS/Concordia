/**
 * 部署の起動既定値を起動要求へ当てはめる純関数。
 *
 * 既定値は「明示されなかった項目」にだけ入る (CC-DEPT-INV-05)。 担当プロジェクトが
 * 設定された部署では、 その外のプロジェクトや、 プロジェクト照合できない生 cwd を
 * 受け付けない (CC-DEPT-INV-04)。
 *
 * @implements spec/feature/departments.md §5
 * @implements SPEC-DEPT-LAUNCH
 */

import type { DepartmentSettings } from "./settings.js";

export interface DepartmentLaunchRequest {
  template?: string | null;
  provider?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  project?: string | null;
  cwd?: string | null;
}

export interface ResolvedDepartmentLaunch {
  template: string | null;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  project: string | null;
  cwd: string | null;
}

export type DepartmentLaunchDenial =
  /** 担当プロジェクトの外。 */
  | "department_project_out_of_scope"
  /** 担当プロジェクトがあるのにプロジェクトが決まらない (workspace root で起動させない)。 */
  | "department_project_required"
  /** 生 cwd はプロジェクト名で照合できない。 */
  | "department_cwd_not_allowed";

export type DepartmentLaunchResult =
  | { ok: true; launch: ResolvedDepartmentLaunch }
  | { ok: false; denial: DepartmentLaunchDenial };

export function applyDepartmentLaunchDefaults(
  request: DepartmentLaunchRequest,
  settings: Pick<DepartmentSettings, "launch" | "projects">,
): DepartmentLaunchResult {
  const defaults = settings.launch;
  const requestedTemplate = trimmed(request.template);
  const requestedProvider = trimmed(request.provider);
  // 起動種別 (テンプレート / provider 直指定) を要求が決めていれば、 部署の既定で
  // 反対側を足さない。 両方未指定のときだけ部署の既定の種別を採る。
  const explicitKind = requestedTemplate !== null || requestedProvider !== null;
  const template = requestedTemplate ?? (explicitKind ? null : trimmed(defaults.template));
  const provider = requestedProvider ?? (explicitKind || template !== null ? null : trimmed(defaults.provider));

  const cwd = trimmed(request.cwd);
  const restricted = settings.projects.length > 0;
  if (cwd !== null) {
    if (restricted) return { ok: false, denial: "department_cwd_not_allowed" };
    return {
      ok: true,
      launch: {
        template,
        provider,
        model: trimmed(request.model) ?? trimmed(defaults.model),
        reasoning_effort: trimmed(request.reasoning_effort) ?? trimmed(defaults.reasoning_effort),
        // cwd と project は排他 (admin spawn の規則)。 cwd 明示時は既定 project を足さない。
        project: null,
        cwd,
      },
    };
  }

  const project = trimmed(request.project) ?? trimmed(defaults.project);
  if (restricted) {
    if (project === null) return { ok: false, denial: "department_project_required" };
    if (!isProjectInDepartment(project, settings.projects)) {
      return { ok: false, denial: "department_project_out_of_scope" };
    }
  }
  return {
    ok: true,
    launch: {
      template,
      provider,
      model: trimmed(request.model) ?? trimmed(defaults.model),
      reasoning_effort: trimmed(request.reasoning_effort) ?? trimmed(defaults.reasoning_effort),
      project,
      cwd: null,
    },
  };
}

/** 大文字小文字を区別せずに担当プロジェクトへ含まれるか。 */
export function isProjectInDepartment(project: string, projects: readonly string[]): boolean {
  const name = project.trim().toLowerCase();
  if (!name) return false;
  return projects.some((candidate) => candidate.trim().toLowerCase() === name);
}

function trimmed(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}
