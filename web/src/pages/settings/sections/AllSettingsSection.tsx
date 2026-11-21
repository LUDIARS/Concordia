// 設定レジストリ (/v1/admin/settings) を全項目まとめて表示・編集するセクション (W5-3)。
//
// これまで DB / env にしか無く WebUI から見えなかった設定をここに全部出す。
// 各項目には「今の値がどこ由来か (db|env|default|none)」を出し、env でしか変えられない
// ものは編集不可であることが分かる形にする (触れるのに効かない、を作らない)。

import { useEffect, useMemo, useState } from "react";
import { api, type SettingItem, type SettingsRejection, type SettingsSectionPayload, type SettingsUpdateOutcome } from "../../../api.js";
import { SourceBadge } from "./SettingSourceBadge.js";
import { SettingValueField } from "./SettingValueField.js";

/** 画面が使う API の口 (テストで差し替える)。 */
export interface AllSettingsClient {
  allSettings(): Promise<{ sections: SettingsSectionPayload[] }>;
  updateSettings(updates: Record<string, unknown>): Promise<SettingsUpdateOutcome>;
}

function describeRejection(r: SettingsRejection): string {
  return `${r.code}${r.detail ? ` (${r.detail})` : ""}${r.managedBy ? ` — ${r.managedBy} で変更` : ""}`;
}

export function AllSettingsSection(props: { client?: AllSettingsClient } = {}) {
  const client = props.client ?? api;
  const [sections, setSections] = useState<SettingsSectionPayload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 拒否された項目ごとの理由。 一覧の上だけに出すと、 下の方の項目を触った人には見えない。
  const [rejectedByKey, setRejectedByKey] = useState<Record<string, string>>({});
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    client.allSettings()
      .then((res) => setSections(res.sections))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const dirtyKeys = Object.keys(drafts);

  const visible = useMemo(() => {
    if (!sections) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return sections;
    return sections
      .map((section) => ({
        ...section,
        settings: section.settings.filter((setting) =>
          [setting.key, setting.label, setting.envName ?? "", setting.dbKey ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        ),
      }))
      .filter((section) => section.settings.length > 0);
  }, [sections, filter]);

  async function save() {
    setBusy(true);
    setError(null);
    setSavedCount(null);
    const outcome = await client.updateSettings(drafts).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    });
    setBusy(false);
    if (!outcome) return;
    if (!outcome.ok) {
      setError(`保存できませんでした (何も保存していません): ${outcome.rejected
        .map((r) => `${r.key || "(全体)"}: ${describeRejection(r)}`)
        .join(" / ")}`);
      setRejectedByKey(Object.fromEntries(
        outcome.rejected.filter((r) => r.key).map((r) => [r.key, describeRejection(r)]),
      ));
      return;
    }
    setSections(outcome.sections);
    setSavedCount(dirtyKeys.length);
    setRejectedByKey({});
    setDrafts({});
  }

  if (error && !sections) return <div className="text-sm text-warn">設定を読めません: {error}</div>;
  if (!sections) return <div className="text-sm text-subtle">読み込み中...</div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">すべての設定</h2>
        <p className="text-xs text-subtle mt-1">
          DB / env の設定を全て表示します。 「出所」 が env のものは env でしか変えられません
          (再起動が要る項目があるため)。
        </p>
      </div>

      {/* 保存ボタンは一覧を下へたどっても見えるよう上に貼り付ける (下の項目を入れて保存せず離れる、を防ぐ)。 */}
      <div className="sticky top-0 z-10 bg-surface py-2 flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="キー / env 名で絞り込み"
          className="foundation-form text-sm flex-1 min-w-0"
        />
        <button
          disabled={busy || dirtyKeys.length === 0}
          onClick={() => void save()}
          className="shrink-0 px-3 py-2 rounded text-sm border bg-accent/15 border-accent text-accent disabled:opacity-40"
        >
          {busy ? "保存中..." : `保存 (${dirtyKeys.length})`}
        </button>
      </div>

      {error ? <div role="alert" className="text-xs text-warn border border-warn/50 rounded p-2">{error}</div> : null}
      {savedCount !== null ? (
        <div role="status" className="text-xs text-ok border border-ok/50 rounded p-2">{savedCount} 件を保存しました</div>
      ) : null}

      {visible.map((section) => (
        <section key={section.id} className="border border-border rounded p-3 space-y-2">
          <div>
            <div className="text-sm font-medium">{section.label}</div>
            <div className="text-[11px] text-subtle mt-0.5">{section.description}</div>
          </div>
          <div className="space-y-2">
            {section.settings.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                draft={drafts[setting.key]}
                hasDraft={setting.key in drafts}
                rejection={rejectedByKey[setting.key]}
                onChange={(next) => setDrafts((prev) => {
                  const updated = { ...prev };
                  if (next === undefined) delete updated[setting.key];
                  else updated[setting.key] = next;
                  return updated;
                })}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SettingRow(props: {
  setting: SettingItem;
  draft: unknown;
  hasDraft: boolean;
  rejection?: string;
  onChange: (next: unknown | undefined) => void;
}) {
  const { setting } = props;
  return (
    <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{setting.label}</div>
          <div className="text-xs text-subtle mt-0.5">{setting.description}</div>
        </div>
        {props.hasDraft ? (
          <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded text-[11px] border border-accent text-accent">未保存</span>
        ) : null}
        <SourceBadge source={setting.source} className={`${props.hasDraft ? "" : "ml-auto "}shrink-0`} />
      </div>

      <SettingValueField
        setting={setting}
        draft={props.draft}
        hasDraft={props.hasDraft}
        onChange={props.onChange}
      />
      {props.rejection ? <div className="text-xs text-warn">保存できませんでした: {props.rejection}</div> : null}

      <div className="text-[11px] text-subtle flex flex-wrap gap-x-3 gap-y-0.5">
        <span className="font-mono">{setting.key}</span>
        {setting.envName ? <span className="font-mono">env: {setting.envName}</span> : null}
        {setting.dbKey ? <span className="font-mono">db: {setting.dbKey}</span> : null}
        {setting.managedBy ? <span>編集は {setting.managedBy}</span> : null}
      </div>
    </div>
  );
}
