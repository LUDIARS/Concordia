import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs } from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";
import { requireOk, runMutation } from "../../lib/mutation.js";
import { type FormMode, type RuleForm as RuleFormState } from "./model.js";

export function RuleForm({
  mode, form, setForm, eventKinds, formError, formSubmitting, aiAssisting,
  onAssist, onSubmit, onCancel,
}: {
  mode: FormMode;
  form: RuleFormState;
  setForm: (f: RuleFormState) => void;
  eventKinds: string[];
  formError: string | null;
  formSubmitting: boolean;
  aiAssisting: boolean;
  onAssist: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const isEdit = mode.kind === "edit";
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      className="bg-surface border border-border rounded p-3 space-y-2 text-sm"
    >
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">
          {isEdit ? `rule "${(mode as any).ruleId}" を編集` : "新 rule 提案 (human)"}
        </h2>
        <button
          type="button"
          onClick={onAssist}
          disabled={aiAssisting}
          className="ml-auto px-2 py-1 bg-warn/20 border border-warn text-warn rounded text-xs disabled:opacity-50"
          title="未入力の項目を AI に補完してもらう (claude CLI 経由 / 既入力は尊重)"
        >
          {aiAssisting ? "AI 補完中…" : "✨ AI に補完してもらう"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          label="id (unique)"
          value={form.id}
          onChange={(v) => setForm({ ...form, id: v })}
          placeholder="my-rule-id"
          required={!isEdit}
          disabled={isEdit}
        />
        <Input
          label="description"
          value={form.description}
          onChange={(v) => setForm({ ...form, description: v })}
          placeholder="どんな rule か (任意)"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="flex flex-col">
          <span className="text-subtle text-xs">trigger</span>
          <select
            value={form.trigger_type}
            onChange={(e) => setForm({ ...form, trigger_type: e.target.value as "tick" | "event" })}
            className="bg-muted border border-border rounded px-2 py-1"
          >
            <option value="tick">tick (周期実行)</option>
            <option value="event">event (発生時)</option>
          </select>
        </label>
        {form.trigger_type === "tick" ? (
          <Input
            label="tick_sec (周期)"
            value={form.tick_sec}
            onChange={(v) => setForm({ ...form, tick_sec: v })}
            type="number"
          />
        ) : (
          <label className="flex flex-col">
            <span className="text-subtle text-xs">event_kind</span>
            <select
              value={form.event_kind}
              onChange={(e) => setForm({ ...form, event_kind: e.target.value })}
              className="bg-muted border border-border rounded px-2 py-1"
            >
              <option value="">(全 event / 任意)</option>
              {eventKinds.map((ek) => (
                <option key={ek} value={ek}>
                  {ek === "*" ? "* (全 event)" : ek}
                </option>
              ))}
            </select>
          </label>
        )}
        <Input
          label="cooldown_sec"
          value={form.cooldown_sec}
          onChange={(v) => setForm({ ...form, cooldown_sec: v })}
          type="number"
        />
      </div>
      <label className="flex flex-col">
        <span className="text-subtle text-xs">instructions (claude CLI に渡す指示)</span>
        <textarea
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono min-h-[100px]"
          placeholder="例: 「直近 30 分で edit が 0 件なら chitchat に『一服中?』 と投稿」"
          required
        />
      </label>
      {!isEdit && (
        <label className="flex items-center gap-2 text-xs text-subtle pt-1">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span>
            即時 enabled で投入する (off の場合は review 待ち disabled で保存され、 上の toggle で有効化)
          </span>
        </label>
      )}
      {formError && <div className="text-danger text-xs">{formError}</div>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="text-subtle text-sm">cancel</button>
        <button
          type="submit"
          disabled={formSubmitting}
          className="px-3 py-1 bg-accent/30 border border-accent text-text rounded text-sm disabled:opacity-50"
        >
          {formSubmitting
            ? "..."
            : isEdit
              ? "save"
              : form.enabled
                ? "propose & enable"
                : "propose (review)"}
        </button>
      </div>
      {!isEdit && (
        <p className="text-subtle text-[11px]">
          既定は <strong>review 待ち</strong> (disabled で保存). 中身を確認してから toggle で有効化.
          チェックを入れた場合は即時 enabled になり、 AI が「不要」と判断すれば後から削除される可能性あり (log に残る).
        </p>
      )}
    </form>
  );
}

function Input({
  label, value, onChange, placeholder, type = "text", required, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col">
      <span className="text-subtle text-xs">{label}{required && <span className="text-danger ml-1">*</span>}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono disabled:opacity-50"
        required={required}
        disabled={disabled}
      />
    </label>
  );
}

export function actionColor(action: string): string {
  switch (action) {
    case "fire":   return "px-1 rounded bg-accent/20 text-accent";
    case "add":    return "px-1 rounded bg-ok/20 text-ok";
    case "remove": return "px-1 rounded bg-warn/20 text-warn";
    case "skip":   return "px-1 rounded bg-subtle/20 text-subtle";
    case "error":  return "px-1 rounded bg-danger/20 text-danger";
    default:       return "px-1 rounded bg-muted text-subtle";
  }
}
