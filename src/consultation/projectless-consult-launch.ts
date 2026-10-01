/**
 * プロジェクトを持たない相談部署から起動するときの作業ディレクトリと閉じ込めを決める
 * (spec/feature/tech-consultation.md §6)。
 *
 * admin spawn から呼ぶ application use case。 対象なら会社ごとの相談用ディレクトリ (Concordia 配下) を
 * 用意して、 そこを cwd とする起動指示を返す。
 * - 本社: 起動要求がプロジェクト・cwd・チーム等を指定していなければ相談用ディレクトリで起動する。
 *   指定があればその指定に従う (対象外)。 ツールは制限しない。
 * - 子会社: 作業領域の指定は拒否し、 claude のツール制限を付ける。
 * 対象でなければ何もしない (プロジェクトを持つ部署・部署なしの起動は従来どおり)。
 *
 * - CC-CONSULT-INV-06: プロジェクト無しで相談用ディレクトリに入るのは、 読み取り専用で担当プロジェクトを持たない部署だけ。
 * - CC-CONSULT-INV-07: 子会社のその起動は本社の作業領域を cwd にせず、 呼び出し側が場所を選べない。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import type { DepartmentRow } from "../db/departments-repo.js";
import { parseDepartmentSettings } from "../departments/settings.js";
import {
  CONSULT_SESSION_ENV,
  PROJECTLESS_CONSULT_CLAUDE_ARGS,
  consultWorkspaceClaudeSettings,
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
  /** ディレクトリを用意し、 Claude Code のローカル設定 (指示ファイル・自動メモリを読まない) を書く。 */
  prepareWorkspace(path: string, claudeSettings: Record<string, unknown>): Promise<void>;
}

export type ProjectlessConsultLaunch =
  | { kind: "none" }
  | {
    kind: "consult-workspace";
    cwd: string;
    /** 子会社だけ: claude のツール制限。 本社は空。 */
    claudeArgs: readonly string[];
    /** 子会社だけ: 初回指示の先頭に置く作業範囲の説明。 本社は null。 */
    restriction: string | null;
    /** 起動 env (自動メモリを読まない)。 */
    env: Readonly<Record<string, string>>;
  }
  | { kind: "error"; status: 400 | 503; error: string };

export async function resolveProjectlessConsultLaunch(
  request: ProjectlessConsultLaunchRequest,
  ports: ProjectlessConsultLaunchPorts,
): Promise<ProjectlessConsultLaunch> {
  const { subsidiaryId, department } = request;
  if (!department) return { kind: "none" };
  let projects: readonly string[];
  try {
    projects = parseDepartmentSettings(department.settings_json).projects;
  } catch {
    // 壊れた設定の部署は部署の起動検証が先に止める。 ここで対象と誤認しない。
    return { kind: "none" };
  }
  const useCase = department.use_case_id ? ports.useCase(department.use_case_id) : null;
  if (!isProjectlessConsultDepartment({ projects, useCase })) return { kind: "none" };
  const inSubsidiary = subsidiaryId !== null;
  if (request.specifiedScope.length > 0) {
    // 本社は明示した作業領域に従う。 子会社は場所を選ばせない。
    if (!inSubsidiary) return { kind: "none" };
    return { kind: "error", status: 400, error: `projectless_consult_scope_fixed: ${request.specifiedScope.join(",")}` };
  }
  if (!ports.workspaceRoot) return { kind: "error", status: 503, error: "projectless_consult_workspace_unavailable" };
  const cwd = projectlessConsultWorkspace(ports.workspaceRoot, subsidiaryId);
  await ports.prepareWorkspace(cwd, consultWorkspaceClaudeSettings());
  return inSubsidiary
    ? {
      kind: "consult-workspace", cwd, claudeArgs: PROJECTLESS_CONSULT_CLAUDE_ARGS, restriction: projectlessConsultRestriction(),
      env: CONSULT_SESSION_ENV,
    }
    : { kind: "consult-workspace", cwd, claudeArgs: [], restriction: null, env: CONSULT_SESSION_ENV };
}
