import { Link, useParams } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../api.js";
import { useLiveQuery, useWsEvent } from "../hooks/useWsEvent.js";

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, refetch } = useLiveQuery(
    () => api.session(id!),
    [],
    id,
  );

  // この session に関する event だけ refetch trigger
  useWsEvent(["session.event", "session.ended", "session.lost", "report.generated"], (ev) => {
    if ("session_id" in ev && ev.session_id === id) refetch();
  });

  if (!id) return <div>session id missing</div>;
  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  const s = data.session;
  const role = (s.metadata as any)?.role_label ?? "雑用係";

  return (
    <div className="space-y-4 max-w-4xl">
      <Link to="/" className="text-sm text-subtle hover:text-accent">
        ← back
      </Link>

      <header className="bg-surface border border-border rounded p-4">
        <div className="flex items-center gap-2 text-xs">
          <span className={`px-1.5 py-0.5 rounded ${statusBadge(s.status)}`}>{s.status}</span>
          <span className="text-subtle">{s.provider}</span>
          <span className="ml-auto text-accent">{role}</span>
        </div>
        <h1 className="mt-2 font-mono text-base">{s.repo_path}</h1>
        <div className="text-xs text-subtle space-x-3">
          <span>id={s.id}</span>
          <span>branch={s.branch ?? "-"}</span>
          <span>host={s.host}</span>
          <span>started={fmtTs(s.started_at)}</span>
          <span>last_seen={fmtTs(s.last_seen_at)}</span>
          {s.ended_at && <span>ended={fmtTs(s.ended_at)}</span>}
        </div>
        {s.status === "ended" && (
          <Link
            to={`/reports/${encodeURIComponent(s.id)}`}
            className="inline-block mt-2 text-accent text-sm"
          >
            view report →
          </Link>
        )}
      </header>

      <section>
        <h2 className="text-base font-semibold mb-2">
          events <span className="text-subtle text-xs ml-2">{data.events.length}</span>
        </h2>
        <ul className="space-y-1">
          {data.events.map((ev) => (
            <li
              key={ev.id}
              className="bg-surface border border-border rounded px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className={kindBadge(ev.kind)}>{ev.kind}</span>
                <span className="text-subtle ml-auto">{fmtTs(ev.ts)}</span>
              </div>
              <pre className="mt-1 text-[11px] text-subtle overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(ev.payload, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function kindBadge(kind: string): string {
  const base = "px-1.5 py-0.5 rounded text-[10px] font-mono";
  switch (kind) {
    case "start":   return `${base} bg-ok/20 text-ok`;
    case "end":     return `${base} bg-subtle/20 text-subtle`;
    case "lost":    return `${base} bg-warn/20 text-warn`;
    case "edit":    return `${base} bg-accent/20 text-accent`;
    case "compact": return `${base} bg-warn/10 text-warn`;
    default:        return `${base} bg-muted text-subtle`;
  }
}
