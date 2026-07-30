import { useCallback, useEffect, useState } from "react";
import { api, type FederationListResult } from "../api.js";
import { useWsEvent } from "../hooks/useWsEvent.js";

/**
 * 拠点 (マルチ拠点連合) — 本社に登録された連合拠点の一覧と接続状態。
 * 「子会社」ページ (/subsidiaries = 出張所 Bot) とは別概念
 * (spec/plan/multi-site-federation.md 用語衝突の注意)。
 */
export function Federation() {
  const [data, setData] = useState<FederationListResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newSiteId, setNewSiteId] = useState("");
  const [newName, setNewName] = useState("");
  const [issuedToken, setIssuedToken] = useState<{ siteId: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.federationList()
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(reload, [reload]);
  useWsEvent(["federation.site.connected", "federation.site.disconnected"], reload);

  const onCreateSite = useCallback(() => {
    if (!newSiteId) return;
    setBusy(true);
    setErr(null);
    api.federationCreateSite({ site_id: newSiteId, name: newName || null })
      .then((r) => {
        setIssuedToken({ siteId: r.site_id, token: r.token });
        setNewSiteId("");
        setNewName("");
        reload();
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  }, [newSiteId, newName, reload]);

  const onRevoke = useCallback((siteId: string) => {
    if (!confirm(`拠点「${siteId}」のトークンを失効します。接続中なら切断されます。よろしいですか?`)) return;
    setBusy(true);
    setErr(null);
    api.federationRevokeSite(siteId)
      .then(reload)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  }, [reload]);

  const fmt = (sec: number | null) => (sec ? new Date(sec * 1000).toLocaleString() : "—");

  return (
    <div className="max-w-5xl space-y-4">
      <header>
        <h1 className="font-semibold">拠点 (マルチ拠点連合)</h1>
        <p className="text-subtle text-sm mt-1">
          本社に登録された連合拠点 (拠点 PC 上のローカル Concordia) の一覧です。
          連合 listener: {data ? (data.listener_enabled ? "有効" : "無効 (CONCORDIA_FEDERATION_LISTEN=1 で有効化)") : "…"}
        </p>
      </header>

      {err && <div className="text-danger text-sm">error: {err}</div>}

      <div className="bg-surface border border-border rounded p-3 space-y-2">
        <div className="text-sm font-medium">拠点を登録してトークンを発行</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={newSiteId}
            onChange={(e) => setNewSiteId(e.target.value)}
            placeholder="site-id (小文字英数とハイフン)"
            className="text-sm bg-transparent border border-border rounded px-2 py-1.5 font-mono"
          />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="表示名 (任意)"
            className="text-sm bg-transparent border border-border rounded px-2 py-1.5"
          />
          <button
            onClick={onCreateSite}
            disabled={busy || !newSiteId}
            className="text-sm border border-accent/60 text-accent rounded px-3 py-1.5 hover:bg-accent/10 disabled:opacity-50"
          >
            発行
          </button>
        </div>
        {issuedToken && (
          <div className="text-xs bg-warn/10 border border-warn/40 rounded p-2 space-y-1">
            <div>
              拠点 <span className="font-mono">{issuedToken.siteId}</span> のトークン (この表示限り。拠点側の
              <code className="mx-1">CONCORDIA_FEDERATION_SITE_TOKEN</code>に設定):
            </div>
            <code className="block break-all select-all">{issuedToken.token}</code>
            <button onClick={() => setIssuedToken(null)} className="text-subtle underline">閉じる</button>
          </div>
        )}
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-subtle border-b border-border">
            <th className="py-1.5 pr-3">拠点 ID</th>
            <th className="py-1.5 pr-3">名前</th>
            <th className="py-1.5 pr-3">接続</th>
            <th className="py-1.5 pr-3">最終応答</th>
            <th className="py-1.5 pr-3">バージョン</th>
            <th className="py-1.5 pr-3">未配送</th>
            <th className="py-1.5 pr-3">状態</th>
            <th className="py-1.5" />
          </tr>
        </thead>
        <tbody>
          {data?.sites.map((s) => (
            <tr key={s.site_id} className="border-b border-border/50">
              <td className="py-1.5 pr-3 font-mono">{s.site_id}</td>
              <td className="py-1.5 pr-3">{s.name ?? "—"}</td>
              <td className="py-1.5 pr-3">
                {s.connection === "online"
                  ? <span className="text-ok">● online</span>
                  : <span className="text-subtle">○ offline</span>}
              </td>
              <td className="py-1.5 pr-3 text-xs">{fmt(s.last_seen_at)}</td>
              <td className="py-1.5 pr-3 text-xs font-mono">{s.site_version ?? "—"}</td>
              <td className="py-1.5 pr-3">{s.pending_events}</td>
              <td className="py-1.5 pr-3 text-xs">{s.status === "revoked" ? <span className="text-danger">失効</span> : "有効"}</td>
              <td className="py-1.5 text-right">
                {s.status === "active" && (
                  <button
                    onClick={() => onRevoke(s.site_id)}
                    disabled={busy}
                    className="text-xs border border-danger/50 text-danger rounded px-2 py-1 hover:bg-danger/10 disabled:opacity-50"
                  >
                    失効
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.sites.length === 0 && (
        <div className="text-subtle text-sm">登録された拠点はまだありません。</div>
      )}
    </div>
  );
}
