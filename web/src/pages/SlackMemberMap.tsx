import { useEffect, useState } from "react";
import { api, type SlackMemberMapEntry } from "../api.js";

// session channel へ起動者を招待するための Discord ID → Slack ID 対応表。
// Slack から起動した session は本人をそのまま招待するので、 Discord 起動分だけ登録する。
// 保存しても bot は再接続しない (招待のたびに読まれる)。

const EMPTY_ROW: SlackMemberMapEntry = { discord_user_id: "", slack_user_id: "" };

export function SlackMemberMapSection() {
  const [rows, setRows] = useState<SlackMemberMapEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.slackMemberMapGet()
      .then((r) => setRows(r.entries))
      .catch((e) => setMsg(`load error: ${String(e)}`));
  }, []);

  function update(index: number, patch: Partial<SlackMemberMapEntry>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const filled = rows.filter((row) => row.discord_user_id.trim() || row.slack_user_id.trim());
      const r = await api.slackMemberMapSet(filled);
      setRows(r.entries);
      setMsg(`保存しました (${r.entries.length} 件)`);
    } catch (e) {
      setMsg(`保存失敗: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "flex-1 bg-muted border border-border rounded px-2 py-1 text-xs font-mono";

  return (
    <section className="bg-surface border border-border rounded p-4 text-sm space-y-3">
      <h2 className="font-semibold">起動者の招待 (メンバー対応表)</h2>
      <p className="text-subtle text-xs">
        session channel を作ると、 その session を起動した人を招待します。 Discord から起動した
        session は、 ここで Discord のユーザ ID に対応する Slack のメンバー ID (U…) を引きます。
        対応が無い人は招待されません。
      </p>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="text"
            value={row.discord_user_id}
            onChange={(e) => update(index, { discord_user_id: e.target.value })}
            placeholder="Discord user ID"
            className={inputClass}
          />
          <span className="text-subtle text-xs">→</span>
          <input
            type="text"
            value={row.slack_user_id}
            onChange={(e) => update(index, { slack_user_id: e.target.value })}
            placeholder="Slack member ID (U…)"
            className={inputClass}
          />
          <button
            onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
            disabled={busy}
            className="px-2 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50"
          >
            削除
          </button>
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => setRows((current) => [...current, { ...EMPTY_ROW }])}
          disabled={busy}
          className="px-3 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50"
        >
          行を追加
        </button>
        <button
          onClick={save}
          disabled={busy}
          className="px-3 py-1 rounded border border-accent bg-accent/20 text-accent text-xs disabled:opacity-50"
        >
          対応表を保存
        </button>
      </div>
      {msg && <div className="text-xs text-subtle">{msg}</div>}
    </section>
  );
}
