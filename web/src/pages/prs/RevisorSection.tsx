import { useEffect, useState } from "react";

import { api, type RevisorLocalPr, type RevisorLocalPrsResult } from "../../api.js";

// Revisor (ローカル PR レビューサービス) の local PR セクション。
//
// GitHub の PR とは別系統 — ローカルクローン上のブランチをそのままレビュー・マージする
// 仕組みなので、 GitHub 側のバケットには混ぜず独立して並べる。 各行と見出しから Revisor の
// WebUI (loopback) を新しいタブで開けるようにしている (Revisor 側は frame-ancestors 'none'
// なので埋め込みはできない)。

/** Revisor の checkStatus → 表示色。 未知値は subtle に落とす。 */
const CHECK_BADGE: Record<string, string> = {
  test_ok: "bg-ok/20 text-ok",
  failed: "bg-danger/20 text-danger",
  action_required: "bg-danger/20 text-danger",
  running: "bg-warn/20 text-warn",
  queued: "bg-warn/20 text-warn",
};

function checkBadge(status: string): string {
  return CHECK_BADGE[status] ?? "bg-subtle/20 text-subtle";
}

function formatIso(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

function RevisorRow({ pr, baseUrl }: { pr: RevisorLocalPr; baseUrl: string | null }) {
  const repoShort = pr.repository.split("/").pop() ?? pr.repository;
  const label = `${repoShort} #${pr.number}`;
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border/50 text-sm">
      <span className="text-subtle text-xs font-mono w-40 shrink-0 truncate" title={pr.repository}>
        {baseUrl
          ? <a href={baseUrl} target="_blank" rel="noreferrer" className="hover:text-accent">{label}</a>
          : label}
      </span>
      <span className="flex-1 truncate" title={pr.title}>
        {pr.title || "(no title)"}
        {pr.draft && <span className="ml-1 text-[10px] text-subtle">draft</span>}
      </span>
      <span className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${checkBadge(pr.checkStatus)}`}>
        {pr.checkStatus}
      </span>
      <span className="text-[11px] text-subtle w-28 shrink-0 truncate" title={pr.headRef}>
        {pr.headRef} → {pr.baseRef}
      </span>
      <span className="text-[11px] text-subtle w-24 shrink-0 truncate" title={pr.author}>
        {pr.author || "—"}
      </span>
      <span className="text-[11px] text-subtle w-32 shrink-0 text-right">
        {formatIso(pr.updatedAt)}
      </span>
    </div>
  );
}

export function RevisorSection() {
  const [data, setData] = useState<RevisorLocalPrsResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      setData(await api.prsRevisor());
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Revisor 連携が無効なら何も出さない (GitHub 側だけのページとして成立させる)。
  // 初回取得前も描かない — 未設定環境で空セクションが一瞬出るのを避ける。
  if (!loadError && (!data || !data.configured)) return null;

  const open = (data?.pull_requests ?? []).filter((pr) => pr.status === "open");
  const closed = (data?.pull_requests ?? []).filter((pr) => pr.status !== "open");

  return (
    <section className="bg-surface border border-border rounded p-3">
      <h2 className="font-semibold text-sm mb-1 flex items-center gap-2 flex-wrap">
        🧪 Revisor local PR
        <span className="text-subtle font-normal">({open.length})</span>
        {data?.base_url && (
          <a
            href={data.base_url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs text-accent"
          >
            Revisor ページを開く ↗
          </a>
        )}
      </h2>
      <p className="text-subtle text-xs mb-2">
        ローカルクローン上のブランチをレビュー・マージするローカル PR。 GitHub の PR とは別系統です。
      </p>

      {loadError && <div className="text-danger text-sm">load error: {loadError}</div>}
      {data?.error && (
        <div className="text-warn text-xs">
          Revisor に接続できません: {data.error} (サービスが停止している可能性があります)
        </div>
      )}

      {open.map((pr) => <RevisorRow key={pr.id} pr={pr} baseUrl={data?.base_url ?? null} />)}

      {open.length === 0 && !data?.error && !loadError && (
        <div className="text-subtle text-sm">open な local PR はありません。</div>
      )}

      {closed.length > 0 && (
        <details className="mt-2">
          <summary className="text-xs text-subtle cursor-pointer">
            マージ / クローズ済み ({closed.length})
          </summary>
          <div className="mt-1">
            {closed.map((pr) => (
              <RevisorRow key={pr.id} pr={pr} baseUrl={data?.base_url ?? null} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
