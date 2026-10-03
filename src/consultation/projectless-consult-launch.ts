/**
 * プロジェクトを持たない相談部署から起動するときの作業ディレクトリと閉じ込めを決める
 * (spec/feature/tech-consultation.md §6)。
 *
 * admin spawn から呼ぶ application use case。 対象なら役職ごとの作業ディレクトリと、 相談者の Discord の
 * 個人 ID のデータフォルダを用意して、 役職のディレクトリを cwd とする起動指示を返す (2026-10-02 neco 指示)。
 * - 本社: 起動要求がプロジェクト・cwd・チーム等を指定していなければ相談用ディレクトリで起動する。
 *   指定があればその指定に従う (対象外)。
 * - 子会社: 作業領域の指定は拒否する。
 * - どちらも claude のツール制限を付け、 相談専用の Claude 設定フォルダ・codex 用の CODEX_HOME で起動する
 *   (2026-10-02 neco 指示「本社の相談も同じで」、 2026-10-03「codex のも作ってほしい」)。
 * 対象でなければ何もしない (プロジェクトを持つ部署・部署なしの起動は従来どおり)。
 *
 * - CC-CONSULT-INV-06: プロジェクト無しで相談用ディレクトリに入るのは、 読み取り専用で担当プロジェクトを持たない部署だけ。
 * - CC-CONSULT-INV-07: 子会社のその起動は本社の作業領域を cwd にせず、 呼び出し側が場所を選べない。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import type { DepartmentRow } from "../db/departments-repo.js";
import { CONSULT_FETCH_LINK_SCRIPT_ENV, consultFetchLinkScript } from "./consult-fetch-link.js";
import { parseDepartmentSettings } from "../departments/settings.js";
import {
  CONSULT_SESSION_ENV,
  PROJECTLESS_CONSULT_CLAUDE_ARGS,
  consultClaudeConfigDir,
  consultCodexHome,
  consultPersonalDataDir,
  consultRoleWorkspace,
  consultWorkspaceClaudeSettings,
  isProjectlessConsultDepartment,
  projectlessConsultRestriction,
  type ProjectlessConsultInput,
} from "./projectless-consult.js";

export interface ProjectlessConsultLaunchRequest {
  subsidiaryId: string | null;
  department: DepartmentRow | null;
  /** 起動要求が作業領域を指定した項目 (project / cwd / team / branch / worktree / テンプレ prompt 注入)。 */
  specifiedScope: readonly string[];
  /** 事前ヒアリングの役職 (作業ディレクトリの役職フォルダを決める)。 */
  roleTitle?: string | null;
  /** 相談者の Discord の個人 ID (データフォルダを作る)。 */
  requesterDiscordUserId?: string | null;
}

export interface ProjectlessConsultLaunchPorts {
  useCase(id: string): ProjectlessConsultInput["useCase"];
  /** 相談用ディレクトリの置き場所。 未設定ならこの起動は受けない。 */
  workspaceRoot: string | undefined;
  /**
   * 役職のディレクトリを用意して Claude Code のローカル設定 (上位の指示ファイル・自動メモリを読まない) を書き、
   * データフォルダがあればそれも作る。
   */
  prepareWorkspace(path: string, claudeSettings: Record<string, unknown>, dataDir: string | null): Promise<void>;
  /**
   * 相談専用の Claude 設定フォルダを用意し、 役職フォルダの信頼を書く。 ログイン済みなら true
   * (未ログインでも Astra (codex) の相談は起動できるので、 ここでは拒否しない)。
   */
  prepareClaudeConfig(configDir: string, roleWorkspace: string): Promise<boolean>;
  /**
   * Astra (codex) の相談専用の CODEX_HOME を用意し、 フック (hooks.json) と設定 (config.toml) を書く。 ログイン済みなら true
   * (未ログインでも claude の相談は起動できるので、 ここでは拒否しない)。
   */
  prepareCodexHome(codexHome: string): Promise<boolean>;
  /**
   * 相談の CODEX_HOME で PreToolUse フックが信頼済みか。 信頼済みのときだけ Astra (codex) に公開リンクの取得コマンドを許す
   * (シェルの制限はフックが担う)。 省略時は false (シェルを外したまま)。
   */
  codexPreToolHookTrusted?(codexHome: string): Promise<boolean>;
}

export type ProjectlessConsultLaunch =
  | { kind: "none" }
  | {
    kind: "consult-workspace";
    cwd: string;
    /** claude のツール制限。 */
    claudeArgs: readonly string[];
    /** 初回指示の先頭に置く作業範囲の説明。 */
    restriction: string | null;
    /** 相談専用の Claude 設定フォルダにログイン済みか (claude で起動するときに必要)。 */
    claudeConfigReady: boolean;
    /** 相談専用の CODEX_HOME にログイン済みか (codex で起動するときに必要)。 */
    codexHomeReady: boolean;
    /** Astra (codex) に公開リンクの取得コマンドを許せるか (相談の CODEX_HOME で PreToolUse フックが信頼済み)。 */
    codexFetchLinkReady: boolean;
    /** 相談者のデータフォルダ (Discord 以外からの起動は null)。 */
    dataDir: string | null;
    /** 起動 env (自動メモリを読まない・データフォルダの場所)。 */
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
  const cwd = consultRoleWorkspace(ports.workspaceRoot, request.roleTitle);
  const dataDir = consultPersonalDataDir(cwd, request.requesterDiscordUserId);
  await ports.prepareWorkspace(cwd, consultWorkspaceClaudeSettings(cwd), dataDir);
  const configDir = consultClaudeConfigDir(ports.workspaceRoot);
  const claudeConfigReady = await ports.prepareClaudeConfig(configDir, cwd);
  const codexHome = consultCodexHome(ports.workspaceRoot);
  const codexHomeReady = await ports.prepareCodexHome(codexHome);
  const codexFetchLinkReady = codexHomeReady && (await ports.codexPreToolHookTrusted?.(codexHome) ?? false);
  const env = {
    ...CONSULT_SESSION_ENV,
    CLAUDE_CONFIG_DIR: configDir,
    CODEX_HOME: codexHome,
    // 公開リンクの取得コマンド。 codex のフックはこのパスのコマンドだけを通す (consult-fetch-link.ts)。
    [CONSULT_FETCH_LINK_SCRIPT_ENV]: consultFetchLinkScript(ports.workspaceRoot),
    ...(dataDir ? { CONCORDIA_CONSULT_DATA_DIR: dataDir } : {}),
  };
  return {
    kind: "consult-workspace", cwd, dataDir, claudeArgs: PROJECTLESS_CONSULT_CLAUDE_ARGS,
    restriction: projectlessConsultRestriction(), claudeConfigReady, codexHomeReady, codexFetchLinkReady, env,
  };
}
