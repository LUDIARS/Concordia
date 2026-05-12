import { Link } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../api.js";
import type { SessionRow } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

export function Monitor() {
  const { data, error } = useLiveQuery(
    () => api.monitor(),
    [
      "session.started",
      "session.ended",
      "session.lost",
      "session.event",
      "persona.assigned",
      "persona.released",
    ],
  );

  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-base font-semibold mb-2">
          repos <span className="text-subtle text-xs ml-2">{data.repos.length}</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {data.repos.length === 0 && (
            <span className="text-subtle text-sm">no active session</span>
          )}
          {data.repos.map((r) => (
            <span
              key={r.key}
              className="px-2 py-1 bg-muted border border-border rounded text-xs"
            >
              {r.key}
              <span className="ml-2 text-accent">×{r.count}</span>
            </span>
          ))}
        </div>
      </section>

      <SessionList title="active" rows={data.active} />
      <SessionList title="lost" rows={data.lost} />
      <SessionList title="recently ended" rows={data.recent_ended} />
    </div>
  );
}

function SessionList({ title, rows }: { title: string; rows: SessionRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="text-base font-semibold mb-2 capitalize">
        {title} <span className="text-subtle text-xs ml-2">{rows.length}</span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {rows.map((s) => (
          <SessionCard key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}

function SessionCard({ s }: { s: SessionRow }) {
  const role = (s.metadata as any)?.role_label ?? "雑用係";
  return (
    <Link
      to={`/sessions/${encodeURIComponent(s.id)}`}
      className="block bg-surface border border-border rounded p-3 hover:border-accent transition-colors"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded ${statusBadge(s.status)}`}>{s.status}</span>
        <span className="text-subtle">{s.provider}</span>
        <span className="ml-auto text-subtle">{s.id.slice(0, 8)}…</span>
      </div>
      <div className="mt-2 text-sm font-mono truncate">{s.repo_path}</div>
      <div className="text-xs text-subtle">
        {s.branch ?? "(no branch)"} @ {s.host}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="text-accent">{role}</span>
        <span className="ml-auto text-subtle">{fmtTs(s.last_seen_at)}</span>
      </div>
      {s.current_task && (
        <div className="mt-2 text-xs bg-muted px-2 py-1 rounded line-clamp-2">
          {s.current_task}
        </div>
      )}
    </Link>
  );
}
