import { useEffect, useState } from "react";
import { api, fmtTs, type SessionLogFull } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

/**
 * 過去の作業ログ (session-logs/<date>.md) を一覧・per-project 閲覧する。
 * 左 = プロジェクト facet、 右 = 一覧 / 選択ログ全文。 同じデータは
 * GET /v1/session-logs と MCP (concordia_list_session_logs) からも取れる。
 */
export function SessionLogs() {
  const [project, setProject] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, error, refetch } = useLiveQuery(
    () => api.sessionLogsList({ project: project ?? undefined, q: q || undefined, limit: 500 }),
    ["session.ended"],
    `${project ?? ""}|${q}`,
  );

  if (error) return <div className="text-danger">load error: {error.message}</div>;

  const projects = data?.projects ?? [];
  const entries = data?.entries ?? [];

  return (
    <div className="max-w-6xl space-y-4">
      <header>
        <h1 className="font-semibold">作業ログ (session-logs)</h1>
        <p className="text-subtle text-sm mt-1">
          各セッション終了時 (<code>/session-end</code>) と引継ぎ (👌/👋) で書かれた作業記録を
          プロジェクト別に閲覧します。 同じデータは <code>GET /v1/session-logs</code> と
          MCP <code>concordia_list_session_logs</code> / <code>concordia_get_session_log</code>
          からも取得でき、 作業引き継ぎ時の文脈復元に使えます。
        </p>
        {data?.root && (
          <p className="text-subtle text-xs mt-1">
            source: <span className="font-mono">{data.root}</span> · {data.total} 件
          </p>
        )}
      </header>

      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="タイトル / 見出し / 抜粋を検索…"
          className="foundation-form flex-1 max-w-md bg-surface border border-border rounded px-3 py-1.5 text-sm"
        />
        <button onClick={() => refetch()} className="text-xs text-subtle hover:text-accent px-2 py-1">
          ⟳ 更新
        </button>
      </div>

      {data?.root == null && (
        <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">
          session-logs ディレクトリが見つかりません (<code>&lt;workspace root&gt;/session-logs</code>)。
          設定の workspace root を確認してください。
        </div>
      )}

      <div className="flex gap-4 items-start">
        {/* 左: プロジェクト facet */}
        <aside className="w-44 shrink-0 space-y-1">
          <button
            onClick={() => { setProject(null); setOpenId(null); }}
            className={
              "w-full text-left px-2 py-1 rounded text-sm " +
              (project === null ? "bg-accent/20 text-accent" : "hover:bg-muted text-subtle")
            }
          >
            すべて <span className="text-xs">({data?.total ?? 0})</span>
          </button>
          {projects.map((p) => (
            <button
              key={p.name}
              onClick={() => { setProject(p.name); setOpenId(null); }}
              className={
                "w-full text-left px-2 py-1 rounded text-sm flex justify-between items-center " +
                (project === p.name ? "bg-accent/20 text-accent" : "hover:bg-muted")
              }
            >
              <span className="truncate">{p.name}</span>
              <span className="text-xs text-subtle ml-1">{p.count}</span>
            </button>
          ))}
        </aside>

        {/* 右: 選択ログ全文 or 一覧 */}
        <section className="flex-1 min-w-0">
          {openId ? (
            <LogDetail id={openId} onClose={() => setOpenId(null)} />
          ) : (
            <ul className="space-y-3">
              {entries.length === 0 && (
                <li className="text-subtle text-sm">該当するログがありません。</li>
              )}
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="bg-surface border border-border rounded p-3 cursor-pointer hover:border-accent/50"
                  onClick={() => setOpenId(e.id)}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-accent">{e.id}</span>
                    <span className="text-subtle ml-auto">{fmtTs(e.mtime)}</span>
                  </div>
                  <div className="mt-1 font-medium text-sm">{e.title}</div>
                  {e.projects.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {e.projects.map((p) => (
                        <span key={p} className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{p}</span>
                      ))}
                    </div>
                  )}
                  {e.sections.length > 0 && (
                    <div className="mt-1 text-[11px] text-subtle truncate">
                      {e.sections.slice(0, 6).join(" · ")}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-subtle line-clamp-2">{e.excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function LogDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<SessionLogFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    api.sessionLog(id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [id]);

  return (
    <div className="space-y-3">
      <button onClick={onClose} className="text-sm text-subtle hover:text-accent">← 一覧へ戻る</button>
      {err && <div className="text-danger text-sm">load error: {err}</div>}
      {!data && !err && <div className="text-subtle text-sm">loading…</div>}
      {data && (
        <>
          <header className="bg-surface border border-border rounded p-3 text-xs space-y-1">
            <div>id: <span className="font-mono text-accent">{data.id}</span></div>
            <div className="text-subtle">{fmtTs(data.mtime)} · {(data.size_bytes / 1024).toFixed(1)} KB</div>
            {data.projects.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {data.projects.map((p) => (
                  <span key={p} className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{p}</span>
                ))}
              </div>
            )}
          </header>
          <section className="bg-surface border border-border rounded p-4">
            <pre className="text-sm whitespace-pre-wrap leading-relaxed">{data.content_md}</pre>
          </section>
        </>
      )}
    </div>
  );
}
