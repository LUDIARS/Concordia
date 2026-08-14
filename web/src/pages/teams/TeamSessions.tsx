/** チーム詳細タブ「セッション一覧」。 GET /v1/sessions?team_id= の read model。 */

import { Link } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";

export function TeamSessions({ teamId }: { teamId: string }) {
  const { data, error } = useLiveQuery(
    () => api.sessions({ teamId }),
    ["session.started", "session.ended", "session.lost", "session.task_changed"],
    teamId,
  );

  if (error) return <div className="text-danger text-sm">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle text-sm">loading…</div>;
  if (data.sessions.length === 0) {
    return <div className="text-subtle text-sm">このチームのセッションはまだありません。</div>;
  }
  return (
    <div className="space-y-2">
      {data.sessions.map((session) => (
        <Link
          key={session.id}
          className="block rounded border border-border bg-surface p-3 hover:border-accent"
          to={`/sessions/${encodeURIComponent(session.id)}`}
        >
          <div className="flex items-center gap-2">
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${statusBadge(session.status)}`}>{session.status}</span>
            <span className="truncate">{session.current_task || session.id}</span>
          </div>
          <div className="text-xs text-subtle">
            {session.provider} · {session.branch ?? "-"} · 開始 {fmtTs(session.started_at)}
          </div>
        </Link>
      ))}
    </div>
  );
}
