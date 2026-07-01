import { useEffect, useState } from "react";
import { api, type WsCleanupResult } from "../api.js";

/**
 * ワークスペース整理 (ws-cleanup)。 dry-run で各リポの「予定アクション」と
 * 「ユーザ判断に委ねる保留」を出し、 実行ボタンで安全アクションだけ適用する。
 * 同じ処理は GET/POST /v1/admin/ws-cleanup でも叩ける。
 */
export function WsCleanup() {
  const [data, setData] = useState<WsCleanupResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"dry" | "apply" | null>(null);

  const loadDry = () => {
    setBusy("dry");
    setErr(null);
    api.wsCleanupDryRun()
      .then(setData)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(null));
  };
  useEffect(loadDry, []);

  const apply = () => {
    if (!confirm("安全アクション (worktree prune / main ff 更新 / マージ済みブランチ削除) を実行します。よろしいですか?")) return;
    setBusy("apply");
    setErr(null);
    api.wsCleanupApply()
      .then(setData)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(null));
  };

  const s = data?.summary;
  return (
    <div className="max-w-5xl space-y-4">
      <header>
        <h1 className="font-semibold">ワークスペース整理 (ws-cleanup)</h1>
        <p className="text-subtle text-sm mt-1">
          各リポの worktree 掃除 / 既定ブランチの ff 最新化 / 「作業中でない」マージ済みブランチの削除を行います。
          未マージ・未コミット変更・作業中ブランチ・追加 worktree は触らず、 下に保留として列挙します。
          <code>reset --hard</code> は使いません。
        </p>
      </header>

      <div className="flex items-center gap-2">
        <button
          onClick={loadDry}
          disabled={busy !== null}
          className="text-sm border border-border rounded px-3 py-1.5 hover:border-accent/50 disabled:opacity-50"
        >
          {busy === "dry" ? "走査中…" : "⟳ dry-run 再走査"}
        </button>
        <button
          onClick={apply}
          disabled={busy !== null || !data}
          className="text-sm border border-accent/60 text-accent rounded px-3 py-1.5 hover:bg-accent/10 disabled:opacity-50"
        >
          {busy === "apply" ? "実行中…" : "安全アクションを実行"}
        </button>
        {s && (
          <span className="text-xs text-subtle ml-2">
            {data?.apply ? "実行結果" : "dry-run"} · {s.repos} repos · actions {s.actions} · 保留 {s.deferred} · errors {s.errors}
          </span>
        )}
      </div>

      {err && <div className="text-danger text-sm">error: {err}</div>}
      {!data && !err && <div className="text-subtle text-sm">loading…</div>}

      <ul className="space-y-2">
        {data?.repos
          .filter((r) => r.actions.length > 0 || r.deferred.length > 0)
          .map((r) => (
            <li key={r.path} className="bg-surface border border-border rounded p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{r.name}</span>
                <span className="text-xs text-subtle font-mono">{r.current_branch ?? "detached"}</span>
                {r.default_branch && (
                  <span className="text-[10px] text-subtle">def: {r.default_branch}</span>
                )}
              </div>
              {r.actions.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {r.actions.map((a, i) => (
                    <li key={i} className="text-xs text-ok">✓ {a}</li>
                  ))}
                </ul>
              )}
              {r.deferred.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {r.deferred.map((d, i) => (
                    <li key={i} className="text-xs text-warn">⚠ {d}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
      </ul>
      {data && data.repos.every((r) => r.actions.length === 0 && r.deferred.length === 0) && (
        <div className="text-subtle text-sm">整理対象・保留はありませんでした。</div>
      )}
    </div>
  );
}
