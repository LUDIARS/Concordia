import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDuration, fmtTs } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

export function Reports() {
  const { data, error, refetch } = useLiveQuery(
    () => api.reportsList(50),
    ["report.generated", "session.ended"],
  );
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (sessionId: string) => {
    if (!confirm(`レポート ${sessionId.slice(0, 12)}… を削除しますか?`)) return;
    setBusy(sessionId);
    try {
      await fetch(`/v1/reports/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      refetch();
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="text-danger">load error: {error.message}</div>;
  const reports = data?.reports ?? [];

  return (
    <div className="max-w-4xl space-y-4">
      <header>
        <h1 className="font-semibold">AI 日報 (per session)</h1>
        <p className="text-subtle text-sm mt-1">
          各セッション終了時 (DELETE /v1/sessions/:id) に claude CLI が narrative を
          書き、 ロール込みで 1 件ずつ独立したレポートが残ります.
          (横断集計は <code>/v1/daily-reports</code> でも見られます)
        </p>
      </header>

      {reports.length === 0 && (
        <div className="bg-surface border border-border rounded p-4 text-subtle text-sm">
          まだレポートがありません. 任意の active session で
          <code className="text-accent mx-1">curl -X DELETE http://127.0.0.1:17330/v1/sessions/&lt;id&gt;</code>
          を呼ぶと生成されます.
        </div>
      )}

      <ul className="space-y-3">
        {reports.map((r) => {
          const b = r.bullets ?? {};
          return (
            <li key={r.session_id} className="bg-surface border border-border rounded p-3">
              <div className="flex items-center gap-2 text-xs">
                <Link
                  to={`/reports/${encodeURIComponent(r.session_id)}`}
                  className="font-mono text-accent"
                >
                  {r.session_id.slice(0, 12)}…
                </Link>
                <span className="text-subtle ml-auto">{fmtTs(r.generated_at)}</span>
                <span className="text-subtle">duration {fmtDuration(r.duration_sec)}</span>
                {b.outcome && (
                  <span
                    className={
                      "px-1.5 py-0.5 rounded text-[10px] " +
                      (b.outcome === "ended"
                        ? "bg-ok/20 text-ok"
                        : b.outcome === "lost"
                          ? "bg-warn/20 text-warn"
                          : "bg-subtle/20 text-subtle")
                    }
                  >
                    {b.outcome}
                  </span>
                )}
                <button
                  onClick={() => void remove(r.session_id)}
                  disabled={busy === r.session_id}
                  className="ml-2 text-subtle hover:text-danger text-[10px]"
                >
                  delete
                </button>
              </div>

              {b.events && (
                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  {Object.entries(b.events).map(([k, v]) => (
                    <span key={k} className="bg-muted px-2 py-0.5 rounded">
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
              )}

              <pre className="mt-2 text-sm whitespace-pre-wrap leading-relaxed">{r.summary_preview}</pre>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
