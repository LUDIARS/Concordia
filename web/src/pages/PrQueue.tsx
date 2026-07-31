import { useEffect, useState } from "react";
import { api, fmtTs, type PrItem, type PrQueueResult } from "../api.js";
import { RevisorSection } from "./prs/RevisorSection.js";

// org の open PR をすべて表示する PR Queue ページ。
// backend の /v1/prs (buildPrQueue) をそのまま使う。pr_records は full-sync が
// org 全体の open PR を取り込むので、 session 由来でない PR も並ぶ。

const CI_BADGE: Record<PrItem["ci_status"], string> = {
  success: "bg-ok/20 text-ok",
  failure: "bg-danger/20 text-danger",
  pending: "bg-warn/20 text-warn",
  unknown: "bg-subtle/20 text-subtle",
};
const REVIEW_LABEL: Record<PrItem["review_state"], string> = {
  approved: "✅ approved",
  needs_review: "🔍 needs review",
  reviewing: "👀 reviewing",
  changes_requested: "✋ changes",
  none: "— ",
};

function PrRow({ pr }: { pr: PrItem }) {
  const repoShort = pr.repo_origin.split("/").pop() ?? pr.repo_origin;
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border/50 text-sm">
      <span className="text-subtle text-xs font-mono w-40 shrink-0 truncate" title={pr.repo_origin}>
        {repoShort} #{pr.number}
      </span>
      <a
        href={pr.url ?? "#"}
        target="_blank"
        rel="noreferrer"
        className="flex-1 truncate hover:text-accent"
        title={pr.title}
      >
        {pr.title || "(no title)"}
      </a>
      <span className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${CI_BADGE[pr.ci_status]}`}>
        {pr.ci_status}
      </span>
      <span className="text-[11px] text-subtle w-28 shrink-0">{REVIEW_LABEL[pr.review_state]}</span>
      <span className="text-[11px] text-subtle w-24 shrink-0 truncate" title={pr.persona_name ?? ""}>
        {pr.persona_name ?? (pr.author_session_id ? "session" : "—")}
      </span>
      <span className="text-[11px] text-subtle w-32 shrink-0 text-right">{fmtTs(pr.updated_at)}</span>
    </div>
  );
}

function Bucket({ title, emoji, items }: { title: string; emoji: string; items: PrItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="bg-surface border border-border rounded p-3">
      <h2 className="font-semibold text-sm mb-1">
        {emoji} {title} <span className="text-subtle font-normal">({items.length})</span>
      </h2>
      <div>
        {items.map((p) => (
          <PrRow key={`${p.repo_origin}#${p.number}`} pr={p} />
        ))}
      </div>
    </section>
  );
}

export function PrQueue() {
  const [data, setData] = useState<PrQueueResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setData(await api.prsQueue());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000); // 30s 自動更新
    return () => clearInterval(t);
  }, []);

  const c = data?.counts;
  return (
    <div className="max-w-5xl space-y-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">PR Queue</h1>
        <span className="text-subtle text-sm">
          {c ? `open ${c.total_active} / ready ${c.ready} / review ${c.needs_review} / wip ${c.in_progress}` : "…"}
        </span>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto px-2 py-1 rounded border border-border text-subtle hover:text-text text-xs disabled:opacity-50"
        >
          {loading ? "…" : "更新"}
        </button>
      </header>

      <p className="text-subtle text-xs">
        org の open PR をすべて表示します (session 由来でない PR も含む)。CI 失敗を先頭に対応優先度順。
      </p>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      {/* Revisor (ローカル PR レビュー) は GitHub PR と別系統なので先頭に独立表示する。 */}
      <RevisorSection />

      {data && (
        <div className="space-y-3">
          <Bucket title="Ready (マージ可)" emoji="✅" items={data.grouped.ready} />
          <Bucket title="In progress (修正中/レビュー中)" emoji="🛠" items={data.grouped.in_progress} />
          <Bucket title="Needs review (レビュー待ち)" emoji="🔍" items={data.grouped.needs_review} />
          <Bucket title="Merged recently" emoji="🟣" items={data.grouped.merged_recent} />
          {data.counts.total_active === 0 && data.grouped.merged_recent.length === 0 && (
            <div className="text-subtle text-sm">open PR はありません。</div>
          )}
        </div>
      )}
    </div>
  );
}
