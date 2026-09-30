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
}).strict();

export const DepartmentSettingsSchema = z.object({
  launch: LaunchDefaultsSchema.default({}),
  projects: z.array(ProjectNameSchema).max(200).default([]),
  output: OutputPolicySchema.default({}),
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

export const DEFAULT_OUTPUT_POLICY: DepartmentOutputPolicy = {
  thinking: "inherit",
  status_card: "inherit",
  session_info_card: "inherit",
  cost_report: "inherit",
};

export const EMPTY_DEPARTMENT_SETTINGS: DepartmentSettings = { launch: {}, projects: [], output: DEFAULT_OUTPUT_POLICY };

/** 保存済みの settings_json を型付きへ解決する。 壊れていれば例外 (無言で空にしない)。 */
export function parseDepartmentSettings(settingsJson: string): DepartmentSettings {
  return DepartmentSettingsSchema.parse(JSON.parse(settingsJson) as unknown);
}
