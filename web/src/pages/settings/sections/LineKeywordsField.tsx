// LINE webhook のサービスの呼びかけの言葉の行。 本文がこの言葉で始まる発言は、 そのサービスだけへ回る。
// 入力は「、」「,」 区切りで、 保存すると設定 services.line_webhook_targets のそのサービスの行だけが書き換わる。
// @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面

import { useState } from "react";

/** 「、」「,」 区切りの入力を呼びかけの言葉の配列にする。 */
export function splitKeywords(text: string): string[] {
  return text.split(/[、,，\n]/).map((word) => word.trim()).filter((word) => word !== "");
}

export interface LineKeywordsFieldProps {
  service: string;
  keywords: string[];
  busy: boolean;
  onSave: (keywords: string[]) => Promise<boolean>;
}

/** @implements spec/feature/line-webhook-relay.md — 管理 API と設定画面 */
export function LineKeywordsField({ service, keywords, busy, onSave }: LineKeywordsFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  async function save() {
    if (await onSave(splitKeywords(draft))) setEditing(false);
  }

  return (
    <div className="contents">
      <dt className="text-subtle" title="本文がこの言葉で始まる発言はこのサービスだけへ回す">呼びかけの言葉</dt>
      <dd className="flex flex-wrap items-center gap-2">
        {editing ? (
          <span className="inline-flex items-center gap-1">
            <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="「、」区切り (例: おてつだい、ごほうび)" aria-label={`${service} の呼びかけの言葉`}
              className="text-xs border border-border rounded px-1 py-0.5 bg-transparent w-64" />
            <button type="button" disabled={busy} onClick={() => void save()}
              className="text-accent disabled:opacity-40">保存</button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}
              className="text-subtle hover:text-text disabled:opacity-40">取消</button>
          </span>
        ) : (
          <>
            <span>{keywords.length > 0 ? keywords.join("、") : "なし"}</span>
            <button type="button" disabled={busy} onClick={() => { setEditing(true); setDraft(keywords.join("、")); }}
              className="text-accent disabled:opacity-40">編集</button>
          </>
        )}
      </dd>
    </div>
  );
}
