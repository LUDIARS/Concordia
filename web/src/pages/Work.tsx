/**
 * Work — ローカルクローン (Ars 直下) の作業状況一覧.
 *
 * 各リポについて「現在ブランチ / worktree / 触っている session」を表示する。
 * GET /v1/work/repos (backend が git で走査) をそのまま並べる。
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtTs, type RepoStatus, type RepoSessionRef } from "../api.js";

const STATUS_DOT: Record<string, string> = {
  active: "text-ok",
  lost: "text-warn",
  abandoned: "text-danger",
  ended: "text-subtle",
};

function SessionChip({ s }: { s: RepoSessionRef }) {
  return (
    <Link
      to={`/sessions/${encodeURIComponent(s.id)}`}
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-muted hover:text-accent"
      title={s.current_task ?? s.id}
    >
      <span className={STATUS_DOT[s.status] ?? "text-subtle"}>●</span>
      <span className="font-mono">{s.id.replace(/^lictor-/, "").slice(0, 8)}</span>
      {s.branch && <span className="text-subtle">@{s.branch}</span>}
    </Link>
  );
}

function RepoCard({ repo }: { repo: RepoStatus }) {
  const activeCount = repo.sessions.filter((s) => s.status === "active").length;
  // active 2+ = 競合の疑い → 最上位ハイライト (ring)。
  const multiActive = activeCount >= 2;
  // worktree は別ブランチに居るのが正常 → 緑枠。 worktree でない main clone が
  // 既定ブランチ (main/master) に居なければ赤枠で警告 (= 戻し忘れ検知)。
  const isWorktree = repo.is_worktree;
  const needsAttention = !isWorktree && !repo.on_default_branch;
  const borderClass = needsAttention
    ? "border-danger"
    : isWorktree
      ? "border-ok"
      : "border-border";
  const branchBadgeClass = needsAttention
    ? "bg-danger/15 text-danger"
    : isWorktree
      ? "bg-ok/15 text-ok"
      : "bg-accent/15 text-accent";
  const ringClass = multiActive ? "ring-2 ring-warn shadow-lg shadow-warn/20" : "";
  return (
    <div className={`bg-surface border ${borderClass} ${ringClass} rounded p-3 space-y-2`}>
      <div className="flex items-center gap-2">
        <span className="font-semibold">{repo.name}</span>
        {isWorktree && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-ok/15 text-ok" title="linked worktree">
            ⌥ worktree
          </span>
        )}
        {repo.branch ? (
          <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${branchBadgeClass}`}>
            {repo.branch}
          </span>
        ) : (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              isWorktree ? "bg-ok/15 text-ok" : "bg-danger/20 text-danger"
            }`}
          >
            {repo.detached ? "detached" : "branch?"}
          </span>
        )}
        {repo.extra_worktree_count > 0 && (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-muted text-subtle"
            title={repo.worktrees.filter((w) => !w.is_main).map((w) => `${w.branch ?? "?"} (${w.path})`).join("\n")}
          >
            +{repo.extra_worktree_count} worktree
          </span>
        )}
        {activeCount > 0 && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${
              multiActive ? "bg-warn/25 text-warn font-semibold" : "bg-ok/20 text-ok"
            }`}
            title={multiActive ? "active session が複数 — 競合の疑い" : undefined}
          >
            {multiActive ? "⚠" : "🟢"} {activeCount} active
          </span>
        )}
        {repo.updated_at !== null && (
          <span className="text-[11px] text-subtle ml-auto" title="HEAD 最終コミット時刻">
            {fmtTs(repo.updated_at)}
          </span>
        )}
        {repo.error && (
          <span className="text-xs text-danger" title={repo.error}>
            ⚠ git error
          </span>
        )}
      </div>

      {repo.extra_worktree_count > 0 && (
        <div className="text-[11px] space-y-0.5">
          {repo.worktrees
            .filter((w) => !w.is_main)
            .map((w) => (
              <div
                key={w.path}
                className="font-mono truncate rounded border border-ok/60 bg-ok/5 text-ok px-1.5 py-0.5"
                title={w.path}
              >
                ⌥ {w.branch ?? "(detached)"} — {w.path}
              </div>
            ))}
        </div>
      )}

      {repo.sessions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {repo.sessions.map((s) => (
            <SessionChip key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Work() {
  const [repos, setRepos] = useState<RepoStatus[] | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.workRepos();
      setRepos(r.repos);
      setRoots(r.roots ?? (r.root ? [r.root] : []));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="max-w-4xl space-y-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Work</h1>
        <span className="text-subtle text-xs font-mono" title={roots.join("\n")}>
          {roots.length <= 1 ? (roots[0] ?? "") : `${roots[0]} +${roots.length - 1}`}
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
        ローカルクローンの現在ブランチ・worktree・作業中セッションの一覧 (30s 自動更新)。
      </p>

      {error && <div className="text-danger text-sm">load error: {error}</div>}

      {repos && repos.length === 0 && (
        <div className="text-subtle text-sm">
          リポジトリが見つかりません (workspace roots: <code>{roots.join(", ") || "未設定"}</code>)。
        </div>
      )}

      {repos && repos.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {repos.map((r) => (
            <RepoCard key={r.path} repo={r} />
          ))}
        </div>
      )}
    </div>
  );
}
