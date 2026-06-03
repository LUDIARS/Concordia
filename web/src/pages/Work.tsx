/**
 * Work — ローカルクローン (Ars 直下) の作業状況一覧.
 *
 * 各リポについて「現在ブランチ / worktree / 触っている session」を表示する。
 * GET /v1/work/repos (backend が git で走査) をそのまま並べる。
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type RepoStatus, type RepoSessionRef } from "../api.js";

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
  return (
    <div className="bg-surface border border-border rounded p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{repo.name}</span>
        {repo.branch ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
            {repo.branch}
          </span>
        ) : (
          <span className="text-xs px-1.5 py-0.5 rounded bg-warn/20 text-warn">
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
          <span className="text-xs px-1.5 py-0.5 rounded bg-ok/20 text-ok">
            🟢 {activeCount} active
          </span>
        )}
        {repo.error && (
          <span className="text-xs text-danger" title={repo.error}>
            ⚠ git error
          </span>
        )}
      </div>

      {repo.extra_worktree_count > 0 && (
        <div className="text-[11px] text-subtle space-y-0.5">
          {repo.worktrees
            .filter((w) => !w.is_main)
            .map((w) => (
              <div key={w.path} className="font-mono truncate" title={w.path}>
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
  const [root, setRoot] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.workRepos();
      setRepos(r.repos);
      setRoot(r.root);
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
        <span className="text-subtle text-xs font-mono">{root}</span>
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
          リポジトリが見つかりません (workspace root: <code>{root || "未設定"}</code>)。
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
