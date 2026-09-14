import { useState } from "react";
import type { ProjectCodeAdminEntry, ProjectCodesAdminResult, ProjectNotificationPreferenceInput } from "../api.js";
import {
  NAMED_DEPLOY_TARGETS,
  SUBSIDIARY_SCOPE_OPTIONS,
  describeDeployTarget,
  describeNotificationPreference,
  hasDeployTarget,
  sameDeployTargets,
  shouldSavePreference,
  toPreferenceInput,
  toggleDeployTarget,
  toggleSubsidiary,
  unlistedDeployTargets,
  type DeployNotifyTarget,
} from "../project-notification-settings.js";

// @implements spec/feature/project-notification-preferences.md — 管理 UI
//
// プロジェクト別のデプロイ / リリース通知設定。 JSON は入力させず、チェックボックスと選択式で
// 本社・子会社の範囲と名前付きの追加宛先を選ぶ。 デプロイとリリースは別々に保存する。

type Subsidiary = ProjectCodesAdminResult["subsidiaries"][number];

export interface NotificationSettingsUpdate {
  deploy_notification?: ProjectNotificationPreferenceInput;
  release_notification?: ProjectNotificationPreferenceInput;
  deploy_notify?: DeployNotifyTarget[];
}

/** @implements spec/feature/project-notification-preferences.md — 一覧の要約 */
export function NotificationSummary({ entry, subsidiaries }: {
  entry: ProjectCodeAdminEntry;
  subsidiaries: readonly Subsidiary[];
}) {
  const subsidiaryName = (id: string) => subsidiaries.find((row) => row.id === id)?.name ?? id;
  return (
    <div className="text-[11px] text-subtle space-y-0.5">
      <div>デプロイ: {describeNotificationPreference(entry.deploy_notification, subsidiaryName)}</div>
      <div>リリース: {describeNotificationPreference(entry.release_notification, subsidiaryName)}</div>
      {entry.deploy_notify.length > 0 && (
        <div>追加宛先: {entry.deploy_notify.map(describeDeployTarget).join(" / ")}</div>
      )}
    </div>
  );
}

/** @implements spec/feature/project-notification-preferences.md — 設定の編集と保存 */
export function NotificationSettingsPanel({ entry, subsidiaries, busy, onSave, onClose }: {
  entry: ProjectCodeAdminEntry;
  subsidiaries: readonly Subsidiary[];
  busy: boolean;
  onSave: (update: NotificationSettingsUpdate) => Promise<boolean>;
  onClose: () => void;
}) {
  const [deploy, setDeploy] = useState(() => toPreferenceInput(entry.deploy_notification));
  const [release, setRelease] = useState(() => toPreferenceInput(entry.release_notification));
  const [deployTouched, setDeployTouched] = useState(false);
  const [releaseTouched, setReleaseTouched] = useState(false);
  const [targets, setTargets] = useState<DeployNotifyTarget[]>(() => entry.deploy_notify.map((row) => ({ ...row })));

  // 触ったイベントだけを送る。 片方の保存がもう片方を明示設定に変えないようにするため。
  const update: NotificationSettingsUpdate = {
    ...(shouldSavePreference(entry.deploy_notification, deploy, deployTouched) ? { deploy_notification: deploy } : {}),
    ...(shouldSavePreference(entry.release_notification, release, releaseTouched) ? { release_notification: release } : {}),
    ...(sameDeployTargets(entry.deploy_notify, targets) ? {} : { deploy_notify: targets }),
  };
  const dirty = Object.keys(update).length > 0;

  /** @implements spec/feature/project-notification-preferences.md — 変更したイベントだけ保存 */
  async function save() {
    if (!dirty) {
      onClose();
      return;
    }
    if (await onSave(update)) onClose();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 items-start">
        <EventPreferenceEditor
          title="デプロイ通知"
          configured={entry.deploy_notification.configured}
          value={deploy}
          subsidiaries={subsidiaries}
          disabled={busy}
          onChange={(next) => { setDeploy(next); setDeployTouched(true); }}
        />
        <EventPreferenceEditor
          title="リリース通知"
          configured={entry.release_notification.configured}
          value={release}
          subsidiaries={subsidiaries}
          disabled={busy}
          onChange={(next) => { setRelease(next); setReleaseTouched(true); }}
        />
        <DeployTargetsEditor targets={targets} disabled={busy} onChange={setTargets} />
      </div>
      <p className="text-[10px] text-subtle">
        「通知する」を外すと、本社・子会社・追加宛先のどこにも送りません。デプロイとリリースは別々に保存され、片方の変更はもう片方に影響しません。
        子会社へは受付チャンネルと子会社ごとに登録済みの通知先を使います。
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
          className="bg-accent/20 border border-accent text-accent rounded px-3 py-1 text-xs disabled:opacity-40"
        >
          保存
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="text-subtle hover:text-text text-xs disabled:opacity-40"
        >
          閉じる
        </button>
      </div>
    </div>
  );
}

/** @implements spec/feature/project-notification-preferences.md — イベントごとの範囲 */
function EventPreferenceEditor({ title, configured, value, subsidiaries, disabled, onChange }: {
  title: string;
  configured: boolean;
  value: ProjectNotificationPreferenceInput;
  subsidiaries: readonly Subsidiary[];
  disabled: boolean;
  onChange: (next: ProjectNotificationPreferenceInput) => void;
}) {
  const set = (patch: Partial<ProjectNotificationPreferenceInput>) => onChange({ ...value, ...patch });
  const inactive = disabled || !value.enabled;
  // 登録から消えた子会社の ID は外せるように見せる (未登録 ID は保存時に拒否される)。
  const unknownIds = value.subsidiary_ids.filter((id) => !subsidiaries.some((row) => row.id === id));
  return (
    <fieldset className="border border-border rounded px-2 pb-2 space-y-1.5 min-w-56">
      <legend className="text-xs font-semibold px-1">{title}</legend>
      {!configured && (
        <p className="text-[10px] text-subtle">未設定 — 保存するまで現行の規則 (本社＋運用対象の子会社) で送ります。</p>
      )}
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={value.enabled} disabled={disabled}
          onChange={(e) => set({ enabled: e.target.checked })} />
        通知する
      </label>
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={value.hq} disabled={inactive}
          onChange={(e) => set({ hq: e.target.checked })} />
        本社へ送る
      </label>
      <label className="text-xs text-subtle block">
        子会社
        <select
          value={value.subsidiary_scope}
          disabled={inactive}
          onChange={(e) => set({ subsidiary_scope: e.target.value as ProjectNotificationPreferenceInput["subsidiary_scope"] })}
          className="foundation-form text-xs block"
        >
          {SUBSIDIARY_SCOPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {value.subsidiary_scope === "selected" && (
        <div className="flex flex-col gap-0.5 pl-1">
          {subsidiaries.length === 0 && <span className="text-[10px] text-subtle">登録済みの子会社がありません。</span>}
          {subsidiaries.map((subsidiary) => (
            <label key={subsidiary.id} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={value.subsidiary_ids.includes(subsidiary.id)} disabled={inactive}
                onChange={(e) => set({ subsidiary_ids: toggleSubsidiary(value.subsidiary_ids, subsidiary.id, e.target.checked) })} />
              {subsidiary.name}
              {!subsidiary.enabled && <span className="text-[10px] text-subtle">(無効 — 有効になるまで送りません)</span>}
            </label>
          ))}
          {unknownIds.map((id) => (
            <label key={id} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked disabled={disabled}
                onChange={() => set({ subsidiary_ids: toggleSubsidiary(value.subsidiary_ids, id, false) })} />
              <span className="font-mono">{id}</span>
              <span className="text-[10px] text-subtle">(登録なし)</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** @implements spec/feature/project-notification-preferences.md — 名前付きの追加宛先 */
function DeployTargetsEditor({ targets, disabled, onChange }: {
  targets: readonly DeployNotifyTarget[];
  disabled: boolean;
  onChange: (next: DeployNotifyTarget[]) => void;
}) {
  const unlisted = unlistedDeployTargets(targets);
  return (
    <fieldset className="border border-border rounded px-2 pb-2 space-y-1.5 min-w-56">
      <legend className="text-xs font-semibold px-1">デプロイの追加宛先</legend>
      <p className="text-[10px] text-subtle">
        このプロジェクトのデプロイ通知だけに足す宛先です (デプロイ通知が有効なときだけ送ります)。URL は設定ページ「デプロイ通知」に名前で登録します。
      </p>
      {NAMED_DEPLOY_TARGETS.map((option) => (
        <label key={`${option.target.kind}:${option.target.target}`} className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={hasDeployTarget(targets, option.target)} disabled={disabled}
            onChange={(e) => onChange(toggleDeployTarget(targets, option.target, e.target.checked))} />
          {option.label}
        </label>
      ))}
      {unlisted.map((target) => (
        <label key={`${target.kind}:${target.target}`} className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked disabled={disabled}
            onChange={() => onChange(toggleDeployTarget(targets, target, false))} />
          <span className="font-mono">{describeDeployTarget(target)}</span>
          <span className="text-[10px] text-subtle">(旧設定の名前)</span>
        </label>
      ))}
    </fieldset>
  );
}
