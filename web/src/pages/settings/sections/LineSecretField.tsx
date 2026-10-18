// LINE webhook の秘密値 1 項目の行。 値は読み返せないので「設定済みかどうか」 だけを映し、
// 入力欄は差し替えのときだけ開く。 保存した値は画面に残さない。
// @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面

import { useState } from "react";

export interface LineSecretFieldProps {
  label: string;
  hint: string;
  present: boolean;
  busy: boolean;
  onSave: (value: string) => Promise<boolean>;
  onClear: () => void;
}

/** @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面 */
export function LineSecretField({ label, hint, present, busy, onSave, onClear }: LineSecretFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  async function save() {
    if (await onSave(draft.trim())) {
      setDraft("");
      setEditing(false);
    }
  }

  return (
    <div className="contents">
      <dt className="text-subtle" title={hint}>{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <span className={present ? "" : "text-warn"}>{present ? "設定済み" : "未設定"}</span>
        <button type="button" disabled={busy} onClick={() => { setEditing(true); setDraft(""); }}
          className="text-accent disabled:opacity-40">{present ? "差し替え" : "入力"}</button>
        {present && (
          <button type="button" disabled={busy} onClick={onClear}
            className="text-subtle hover:text-text disabled:opacity-40">消去</button>
        )}
        {editing && (
          <span className="inline-flex items-center gap-1">
            <input type="password" autoComplete="off" spellCheck={false} value={draft}
              onChange={(e) => setDraft(e.target.value)} placeholder={hint}
              className="text-xs font-mono border border-border rounded px-1 py-0.5 bg-transparent w-64" />
            <button type="button" disabled={busy} onClick={() => void save()}
              className="text-accent disabled:opacity-40">保存</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(""); }}
              className="text-subtle hover:text-text disabled:opacity-40">取消</button>
          </span>
        )}
      </dd>
    </div>
  );
}
