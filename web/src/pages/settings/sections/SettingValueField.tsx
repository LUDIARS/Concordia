// 設定項目 1 件の入力コントロール。kind に応じた形を出す。
//
// 編集不可 (env 専用 / 構造化設定) は入力ではなく現在値の表示にする。
// secret は値を出さず「設定済み / 未設定」だけを示し、入力は書き込み専用。

import type { SettingItem } from "../../../api.js";

const INPUT = "foundation-form text-sm w-full min-w-0";

export function SettingValueField(props: {
  setting: SettingItem;
  draft: unknown;
  hasDraft: boolean;
  onChange: (next: unknown | undefined) => void;
}) {
  const { setting } = props;
  const current = props.hasDraft ? props.draft : setting.value;

  if (!setting.editable) return <ReadOnlyValue setting={setting} />;

  switch (setting.kind) {
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={current === true}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          <span>{current === true ? "有効" : "無効"}</span>
        </label>
      );

    case "integer":
      return (
        <input
          type="number"
          className={INPUT}
          value={typeof current === "number" ? current : ""}
          min={setting.minValue}
          max={setting.maxValue}
          step={1}
          onChange={(e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );

    case "enum":
      return (
        <select
          className={INPUT}
          value={typeof current === "string" ? current : ""}
          onChange={(e) => props.onChange(e.target.value)}
        >
          {(setting.enumValues ?? []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      );

    case "string-list":
      return (
        <textarea
          className={`${INPUT} font-mono`}
          rows={Math.min(6, Math.max(2, (Array.isArray(current) ? current.length : 0) + 1))}
          value={Array.isArray(current) ? (current as string[]).join("\n") : ""}
          onChange={(e) => props.onChange(e.target.value.split("\n").map((line) => line.trim()).filter(Boolean))}
          placeholder="1 行に 1 件"
        />
      );

    case "secret":
      return (
        <div className="space-y-1">
          <div className="text-xs text-subtle">
            現在: {setting.set ? "設定済み (値は表示しません)" : "未設定"}
          </div>
          <input
            type="password"
            className={INPUT}
            value={typeof props.draft === "string" ? props.draft : ""}
            onChange={(e) => props.onChange(e.target.value.trim() ? e.target.value : undefined)}
            placeholder="新しい値を入力"
            autoComplete="new-password"
          />
          {props.draft === null ? (
            <div className="flex items-center gap-2 text-xs text-warn">
              <span>保存すると削除します</span>
              <button type="button" className="underline" onClick={() => props.onChange(undefined)}>
                取り消す
              </button>
            </div>
          ) : setting.set ? (
            <button type="button" className="text-xs text-warn underline" onClick={() => props.onChange(null)}>
              保存済みの値を削除
            </button>
          ) : null}
        </div>
      );

    case "json":
      // definitions 側で editable=false を強制しているのでここには来ない。
      return <ReadOnlyValue setting={setting} />;

    case "string":
      return (
        <input
          type="text"
          className={INPUT}
          value={typeof current === "string" ? current : ""}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
  }
}

function ReadOnlyValue(props: { setting: SettingItem }) {
  const { setting } = props;
  if (setting.kind === "secret") {
    return <div className="text-xs text-subtle">現在: {setting.set ? "設定済み (値は表示しません)" : "未設定"}</div>;
  }
  return (
    <div className="text-xs font-mono bg-surface border border-border rounded px-2 py-1 overflow-x-auto">
      {formatValue(setting.value)}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(未設定)";
  if (Array.isArray(value)) return value.length ? value.join(" ; ") : "(空)";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, string>);
    return entries.length ? entries.map(([k, v]) => `${k} → ${v}`).join(" / ") : "(空)";
  }
  if (typeof value === "boolean") return value ? "有効" : "無効";
  return String(value);
}
