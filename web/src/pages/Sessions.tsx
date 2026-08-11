import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

/** @implements spec/feature/session-message-webui-chat.md — D5 sessions index */

export function Sessions() {
  const { data, error } = useLiveQuery(
    () => api.sessions(),
    ["session.started", "session.ended", "session.lost", "session.task_changed"],
  );
  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;
  return (
    <div className="max-w-4xl space-y-3">
      <h1 className="font-semibold">セッション</h1>
      {data.sessions.map((session) => (
        <Link
          className="block rounded border border-border bg-surface p-3 hover:border-accent"
          to={`/sessions/${encodeURIComponent(session.id)}`}
          key={session.id}
        >
          <div>{session.current_task || session.id}</div>
          <div className="text-xs text-subtle">{session.status} · {session.branch ?? "-"} · {session.repo_path}</div>
        </Link>
      ))}
    </div>
  );
}
