/**
 * 部署の設定 (settings_json) の契約。 起動既定値と担当プロジェクトを型付きで持つ。
 *
 * 保存前にここで検証し、 読み出しも同じ schema を通す。 壊れた行を空の既定値へ
 * 黙って置き換えると「部署を選んだのに既定値も範囲制限も効かない」無言の劣化に
 * なるため、 読み出しの失敗は呼び出し側へ例外として返す。
 *
 * @implements spec/feature/departments.md §5
 * @implements SPEC-DEPT-LAUNCH
 * @implements SPEC-DEPT-OUTPUT
 * @implements SPEC-CONSULT-PRIVATE
 * @implements SPEC-USAGE-BUDGET-MULTIPLIER
 */

import { z } from "zod";

/** admin spawn の project 名と同じ規則 (workspace root 直下のディレクトリ名)。 */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ProjectNameSchema = z.string().trim().regex(PROJECT_NAME, "invalid project name");

const LaunchDefaultsSchema = z.object({
  template: z.string().trim().min(1).max(200).optional(),
  provider: z.string().trim().min(1).max(50).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  reasoning_effort: z.string().trim().min(1).max(50).optional(),
  project: ProjectNameSchema.optional(),
}).strict();

/** 出力 1 項目の方針。 inherit は全体設定 (WebUI の設定画面) に従う。 */
const OutputModeSchema = z.enum(["inherit", "on", "off"]);

/** 部署ごとの出力方針 (spec/feature/departments.md §9.4)。 */
const OutputPolicySchema = z.object({
  thinking: OutputModeSchema.default("inherit"),
  status_card: OutputModeSchema.default("inherit"),
  session_info_card: OutputModeSchema.default("inherit"),
  cost_report: OutputModeSchema.default("inherit"),
  // 2026-10-02 neco 指示 (技術相談課は「FINAL ANSWER のみ」・Inject 指令は非表示・コンテキストサイズも不要)。
  /** 指示 1 回ごとの最後の発言 (最終回答) 以外の、 途中の発言。 */
  intermediate: OutputModeSchema.default("inherit"),
  /** Cc が送った指令 (inject) の転記。 */
  inject_transcript: OutputModeSchema.default("inherit"),
  /** コンテキストの使用量 (サイズ) の表示。 */
  context_usage: OutputModeSchema.default("inherit"),
  /**
   * セッション終了時の /session-end の自動指示と、 #報告 への独白 (2026-10-02 neco 指示、 相談はクローズしないので出さない)。
   * 全体設定は無く、 inherit は出す。
   */
  session_end_report: OutputModeSchema.default("inherit"),
}).strict();

/**
 * 起動時の Cc の注入 (作業ポリシー・プロジェクト規則・共通資料と以後の policy update)。
 * `initial-only` は初回指示 (前提データと依頼本文) だけを渡す (技術相談課、 2026-10-02 neco 指示)。
 */
const StartupInjectSchema = z.enum(["full", "initial-only"]);

/**
 * 自動確認 (応答が止まったときの確認と Goal & Go の継続確認)。 `off` の部署のセッションには送らない
 * (技術相談課、 2026-10-02 neco 指示「相談セッションは自動確認しない」)。
 */
const AutoCheckSchema = z.enum(["on", "off"]);

/**
 * 相談 (プロジェクト無しの読み取り専用部署) のツール制限 (spec/feature/tech-consultation.md §6)。
 * `restricted` は Web 検索・ToDo・スキルと公開リンクの取得コマンドだけ。 `all` はツールの制限を外す
 * (2026-10-06 neco 指示「Consult のハーネスをすべて許可する設定」、 選択「ツール制限だけ外す」)。
 * `all` でも個人情報・機密の内容判定と、 利用者の MCP・メモリ・上位の指示ファイルを読ませない閉じ込めは残す。
 */
const ConsultToolsSchema = z.enum(["restricted", "all"]);

/**
 * プライベート相談 (spec/feature/tech-consultation.md §4)。 enabled の部署だけ `/consult` を受け付け、
 * 社員名簿で approver_min_role 以上の人を閉じたチャンネルへ自動で加える。
 */
const PrivateConsultationSchema = z.object({
  enabled: z.boolean().default(false),
  approver_min_role: z.enum(["manager", "executive"]).default("manager"),
}).strict();

/**
 * 月次予算の数え方 (spec/feature/usage-budgets.md §3.1、 2026-10-02 neco 指示)。 この部署のセッションの消費は
 * 本来のトークン × cost_multiplier で予算から引く (例: モデル固定の相談部署は 0.25)。 既定 1。
 */
const BudgetSettingsSchema = z.object({
  cost_multiplier: z.number().gt(0).max(10).default(1),
}).strict();

export const DepartmentSettingsSchema = z.object({
  launch: LaunchDefaultsSchema.default({}),
  projects: z.array(ProjectNameSchema).max(200).default([]),
  output: OutputPolicySchema.default({}),
  private: PrivateConsultationSchema.default({}),
  startup_inject: StartupInjectSchema.default("full"),
  auto_check: AutoCheckSchema.default("on"),
  budget: BudgetSettingsSchema.default({}),
  consult_tools: ConsultToolsSchema.default("restricted"),
}).strict().superRefine((settings, ctx) => {
  const lowered = settings.projects.map((project) => project.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projects"], message: "duplicate project" });
  }
  // テンプレートは provider を内包する。 両方を既定にすると、 どちらで起動するかが
  // 起動経路ごとに変わってしまうため片方に限る。
  if (settings.launch.template && settings.launch.provider) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["launch"],
      message: "launch.template and launch.provider are mutually exclusive",
    });
  }
  const defaultProject = settings.launch.project?.toLowerCase();
  if (defaultProject && lowered.length > 0 && !lowered.includes(defaultProject)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["launch", "project"],
      message: "launch.project must be one of projects",
    });
  }
});

export type DepartmentSettings = z.infer<typeof DepartmentSettingsSchema>;
/** 書き込み入力の形 (既定値で埋まる前)。 検証は DepartmentService が行う。 */
export type DepartmentSettingsInput = z.input<typeof DepartmentSettingsSchema>;
export type DepartmentLaunchDefaults = DepartmentSettings["launch"];
export type DepartmentOutputPolicy = DepartmentSettings["output"];
export type DepartmentOutputItem = keyof DepartmentOutputPolicy;
export type DepartmentOutputMode = DepartmentOutputPolicy[DepartmentOutputItem];
export type DepartmentPrivateConsultation = DepartmentSettings["private"];
export type DepartmentStartupInject = DepartmentSettings["startup_inject"];
export type DepartmentAutoCheck = DepartmentSettings["auto_check"];
export type DepartmentBudgetSettings = DepartmentSettings["budget"];
export type DepartmentConsultTools = DepartmentSettings["consult_tools"];

export const DEFAULT_PRIVATE_CONSULTATION: DepartmentPrivateConsultation = { enabled: false, approver_min_role: "manager" };

export const DEFAULT_OUTPUT_POLICY: DepartmentOutputPolicy = {
  thinking: "inherit",
  status_card: "inherit",
  session_info_card: "inherit",
  cost_report: "inherit",
  intermediate: "inherit",
  inject_transcript: "inherit",
  context_usage: "inherit",
  session_end_report: "inherit",
};

export const EMPTY_DEPARTMENT_SETTINGS: DepartmentSettings = {
  launch: {}, projects: [], output: DEFAULT_OUTPUT_POLICY, private: DEFAULT_PRIVATE_CONSULTATION, startup_inject: "full", auto_check: "on",
  budget: { cost_multiplier: 1 },
  consult_tools: "restricted",
};

/** 保存済みの settings_json を型付きへ解決する。 壊れていれば例外 (無言で空にしない)。 */
export function parseDepartmentSettings(settingsJson: string): DepartmentSettings {
  return DepartmentSettingsSchema.parse(JSON.parse(settingsJson) as unknown);
}
