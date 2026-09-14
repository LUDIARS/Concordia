import type {
  NotificationSubsidiaryScope,
  ProjectCodeAdminEntry,
  ProjectNotificationPreference,
  ProjectNotificationPreferenceInput,
} from "./api.js";

/**
 * プロジェクト別通知設定の管理 UI が使う表示と編集値の変換 (React に依存しない)。
 * @implements spec/feature/project-notification-preferences.md — 管理 UI
 */

export type DeployNotifyTarget = ProjectCodeAdminEntry["deploy_notify"][number];

export const SUBSIDIARY_SCOPE_OPTIONS: ReadonlyArray<{ value: NotificationSubsidiaryScope; label: string }> = [
  { value: "none", label: "子会社へ送らない" },
  { value: "operating", label: "運用対象の子会社" },
  { value: "all", label: "全ての子会社" },
  { value: "selected", label: "子会社を個別に選ぶ" },
];

/**
 * デプロイの追加宛先として選べる名前付き宛先。 webhook の URL は設定ページ「デプロイ通知」に
 * 名前 (discord / slack) で保存され、project には名前だけを持つ。
 */
export const NAMED_DEPLOY_TARGETS: ReadonlyArray<{ target: DeployNotifyTarget; label: string }> = [
  { target: { kind: "discord", target: "discord" }, label: "Discord webhook「discord」" },
  { target: { kind: "slack", target: "slack" }, label: "Slack webhook「slack」" },
  { target: { kind: "cc-channel", target: "" }, label: "Cc デプロイ通知チャンネル" },
];

export function describeNotificationPreference(
  preference: ProjectNotificationPreference,
  subsidiaryName: (id: string) => string,
): string {
  if (!preference.configured) return "未設定 (現行規則)";
  if (!preference.enabled) return "通知しない";
  const parts: string[] = [];
  if (preference.hq) parts.push("本社");
  if (preference.subsidiary_scope === "selected") parts.push(...preference.subsidiary_ids.map(subsidiaryName));
  else if (preference.subsidiary_scope !== "none") parts.push(scopeLabel(preference.subsidiary_scope));
  return parts.length > 0 ? parts.join("＋") : "宛先なし";
}

export function describeDeployTarget(target: DeployNotifyTarget): string {
  return NAMED_DEPLOY_TARGETS.find((option) => sameTarget(option.target, target))?.label
    ?? `${target.kind}:${target.target || "専用ch"}`;
}

export function toPreferenceInput(preference: ProjectNotificationPreference): ProjectNotificationPreferenceInput {
  return {
    enabled: preference.enabled,
    hq: preference.hq,
    subsidiary_scope: preference.subsidiary_scope,
    subsidiary_ids: [...preference.subsidiary_ids],
  };
}

/** 保存が要るか。 未設定のイベントは触った時点で、現行規則と同じ値でも明示設定として保存する。 */
export function shouldSavePreference(
  original: ProjectNotificationPreference,
  draft: ProjectNotificationPreferenceInput,
  touched: boolean,
): boolean {
  if (!touched) return false;
  if (!original.configured) return true;
  return !samePreference(toPreferenceInput(original), draft);
}

export function toggleSubsidiary(ids: readonly string[], id: string, checked: boolean): string[] {
  const rest = ids.filter((value) => value !== id);
  return checked ? [...rest, id] : rest;
}

export function hasDeployTarget(targets: readonly DeployNotifyTarget[], target: DeployNotifyTarget): boolean {
  return targets.some((row) => sameTarget(row, target));
}

export function toggleDeployTarget(
  targets: readonly DeployNotifyTarget[],
  target: DeployNotifyTarget,
  checked: boolean,
): DeployNotifyTarget[] {
  const rest = targets.filter((row) => !sameTarget(row, target));
  return checked ? [...rest, { ...target }] : rest;
}

/** 名前付きの選択肢に無い既存宛先 (旧設定で入った名前)。 編集では外すことだけができる。 */
export function unlistedDeployTargets(targets: readonly DeployNotifyTarget[]): DeployNotifyTarget[] {
  return targets.filter((row) => !NAMED_DEPLOY_TARGETS.some((option) => sameTarget(option.target, row)));
}

export function sameDeployTargets(a: readonly DeployNotifyTarget[], b: readonly DeployNotifyTarget[]): boolean {
  return a.length === b.length && a.every((row) => hasDeployTarget(b, row));
}

function scopeLabel(scope: NotificationSubsidiaryScope): string {
  return SUBSIDIARY_SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope;
}

function samePreference(a: ProjectNotificationPreferenceInput, b: ProjectNotificationPreferenceInput): boolean {
  // 個別選択以外の範囲では ID は保存時に捨てられるので、比較にも含めない。
  const idsOf = (value: ProjectNotificationPreferenceInput) => (value.subsidiary_scope === "selected" ? value.subsidiary_ids : []);
  const left = idsOf(a);
  const right = idsOf(b);
  return a.enabled === b.enabled
    && a.hq === b.hq
    && a.subsidiary_scope === b.subsidiary_scope
    && left.length === right.length
    && left.every((id) => right.includes(id));
}

function sameTarget(a: DeployNotifyTarget, b: DeployNotifyTarget): boolean {
  return a.kind === b.kind && a.target === b.target;
}
