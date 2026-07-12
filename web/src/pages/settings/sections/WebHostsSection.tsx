// 設定ページの各セクション。Settings.tsx が左メニューで切り替えて表示する。
// web-hosts: Vite allowedHosts を concordia.config.json 経由で管理。
// runtime kill switch (chat-mute / rules-enabled) は旧 Rules ページの
// AdminTogglesPanel から移設。reaction-workflow / workspace / Lictor は新規。

import { useEffect, useState } from "react";
import { api } from "../../../api.js";

import { ToggleRow, TextSettingRow, MultiRootSettingRow } from "./common.js";

// ─── Web allowedHosts (Vite dev server のアクセス許可ホスト) ─────────────

export function WebHostsSection() {
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh() {
    try {
      const r = await fetch("/v1/admin/web-hosts").then((res) => res.json()) as { allowed_hosts: string[] };
      setHosts(r.allowed_hosts);
      setDraft(r.allowed_hosts.join("\n"));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }

  async function apply() {
    const parsed = draft.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await fetch("/v1/admin/web-hosts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed_hosts: parsed }),
      }).then((res) => res.json()) as { allowed_hosts: string[]; note?: string };
      setHosts(r.allowed_hosts);
      setDraft(r.allowed_hosts.join("\n"));
      if (r.note) setNote(r.note);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const currentJoined = (hosts ?? []).join("\n");
  const parsedDraft = draft.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-sm">Web allowedHosts</h2>
        <p className="text-subtle text-xs mt-0.5">
          Vite dev server が受け付ける外部ホスト名 (concordia.config.json の <code>web.allowedHosts</code>)。
          <code>localhost</code> / <code>127.0.0.1</code> は常に許可されるため不要。
          Cloudflare Tunnel・Tailscale など外部経由でアクセスするホスト名を 1 行 1 ホストで登録。
          <strong className="text-warn"> 変更は dev server 再起動後に反映。</strong>
        </p>
      </div>

      <div className="bg-muted/40 border border-border rounded p-3 space-y-2">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-xs text-subtle shrink-0 pt-1">現在:</span>
          <div className="flex flex-col gap-0.5">
            {hosts === null ? (
              <span className="text-xs text-subtle">...</span>
            ) : hosts.length === 0 ? (
              <span className="text-xs text-subtle">(未設定)</span>
            ) : (
              hosts.map((h) => (
                <span key={h} className="px-2 py-0.5 rounded text-xs border bg-ok/20 border-ok text-ok font-mono">{h}</span>
              ))
            )}
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder={"concordia.example.com\nccm.example.com"}
          className="bg-muted border border-border rounded px-2 py-1 text-sm font-mono w-full"
        />
        <button
          disabled={busy || parsedDraft.join("\n") === currentJoined}
          onClick={() => void apply()}
          className="self-start px-3 py-1 bg-accent/15 border border-accent text-accent rounded text-xs disabled:opacity-40"
        >
          apply
        </button>
        {note && <div className="text-xs text-subtle">{note}</div>}
      </div>

      {error && <div className="text-danger text-xs">{error}</div>}
    </section>
  );
}
