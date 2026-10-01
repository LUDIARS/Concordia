/**
 * 子会社のプロジェクトを持たない相談部署から起動するときの閉じ込めを決める (spec/feature/tech-consultation.md §6)。
 *
 * admin spawn から呼ぶ application use case。 対象なら、 起動要求が作業領域を指定していないことを確かめ、
 * 子会社ごとの空の相談用ディレクトリを用意して、 そこを cwd とする起動指示 (claude の引数・初回指示の制限文)
 * を返す。 対象でなければ何もしない (本社・プロジェクトを持つ部署の起動は従来どおり)。
 *
 * - CC-CONSULT-INV-06: 子会社のプロジェクト無し起動は、 読み取り専用で担当プロジェクトを持たない部署だけ。
 * - CC-CONSULT-INV-07: その起動は本社の作業領域を cwd にせず、 呼び出し側が場所を選べない。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import type { DepartmentRow } from "../db/departments-repo.js";
import { parseDepartmentSettings } from "../departments/settings.js";
import {
  PROJECTLESS_CONSULT_CLAUDE_ARGS,
  isProjectlessConsultDepartment,
  projectlessConsultRestriction,
  projectlessConsultWorkspace,
  type ProjectlessConsultInput,
} from "./projectless-consult.js";

export interface ProjectlessConsultLaunchRequest {
  subsidiaryId: string | null;
  department: DepartmentRow | null;
  /** 起動要求が作業領域を指定した項目 (project / cwd / team / branch / worktree / テンプレ prompt 注入)。 */
  specifiedScope: readonly string[];
}

export interface ProjectlessConsultLaunchPorts {
  useCase(id: string): ProjectlessConsultInput["useCase"];
  /** 相談用ディレクトリの置き場所。 未設定ならこの起動は受けない。 */
  workspaceRoot: string | undefined;
  ensureDir(path: string): Promise<void>;
}

export type ProjectlessConsultLaunch =
  | { kind: "none" }
  | { kind: "confined"; cwd: string; claudeArgs: readonly string[]; restriction: string }
  | { kind: "error"; status: 400 | 503; error: string };

export async function resolveProjectlessConsultLaunch(
  request: ProjectlessConsultLaunchRequest,
  ports: ProjectlessConsultLaunchPorts,
): Promise<ProjectlessConsultLaunch> {
  const { subsidiaryId, department } = request;
  if (!subsidiaryId || !department) return { kind: "none" };
  let projects: readonly string[];
  try {
    projects = parseDepartmentSettings(department.settings_json).projects;
  } catch {
    // 壊れた設定の部署は部署の起動検証が先に止める。 ここで閉じ込め対象と誤認しない。
    return { kind: "none" };
  }
  const useCase = department.use_case_id ? ports.useCase(department.use_case_id) : null;
  if (!isProjectlessConsultDepartment({ projects, useCase })) return { kind: "none" };
  if (request.specifiedScope.length > 0) {
    return { kind: "error", status: 400, error: `projectless_consult_scope_fixed: ${request.specifiedScope.join(",")}` };
  }
  if (!ports.workspaceRoot) return { kind: "error", status: 503, error: "projectless_consult_workspace_unavailable" };
  const cwd = projectlessConsultWorkspace(ports.workspaceRoot, subsidiaryId);
  await ports.ensureDir(cwd);
  return { kind: "confined", cwd, claudeArgs: PROJECTLESS_CONSULT_CLAUDE_ARGS, restriction: projectlessConsultRestriction() };
}
