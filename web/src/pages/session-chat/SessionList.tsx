import { Link } from "react-router-dom";
import type { SessionRow } from "../../api.js";

/** @implements spec/feature/session-message-webui-chat.md — D4 session sidebar and unread badges */

export function SessionList({ sessions, activeId, unread }: { sessions: SessionRow[]; activeId?: string; unread: Map<string, number> }) {
  return (
    <nav className="space-y-1 p-2" aria-label="セッション一覧">
      {sessions.map((session) => {
        const unreadCount = unread.get(session.id) ?? 0;
        return (
          <Link
            key={session.id}
            to={`/sessions/${encodeURIComponent(session.id)}`}
            className={`block rounded px-3 py-2 text-sm ${session.id === activeId ? "bg-accent/20 text-accent" : "hover:bg-muted"}`}
          >
            <div className="flex gap-2">
              <span className={session.status === "active" ? "text-ok" : "text-subtle"}>●</span>
              <span className="truncate">{session.current_task || session.id.slice(0, 12)}</span>
              {unreadCount > 0 && (
                <span className="ml-auto rounded-full bg-accent px-1.5 text-xs text-white">{unreadCount}</span>
              )}
            </div>
            <div className="truncate pl-4 text-xs text-subtle">{session.branch ?? session.provider}</div>
          </Link>
        );
      })}
    </nav>
  );
}
