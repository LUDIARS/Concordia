import { Link, useParams } from "react-router-dom";
import { api, fmtDuration, fmtTs } from "../api.js";
import { useLiveQuery, useWsEvent } from "../hooks/useWsEvent.js";

export function ReportView() {
  const { id } = useParams<{ id: string }>();
  const { data, error, refetch } = useLiveQuery(() => api.report(id!), [], id);
  useWsEvent("report.generated", (ev) => {
    if (ev.type === "report.generated" && ev.session_id === id) refetch();
  });
  if (!id) return <div>missing id</div>;
  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  const bullets = data.bullets ?? {};
  return (
    <div className="max-w-4xl space-y-4">
      <Link to={`/sessions/${encodeURIComponent(id)}`} className="text-sm text-subtle hover:text-accent">
        ← session
      </Link>

      <header className="bg-surface border border-border rounded p-4 text-xs">
        <div>session_id: <span className="font-mono">{data.session_id}</span></div>
        <div>generated: <span className="text-subtle">{fmtTs((data as any).generated_at ?? 0)}</span></div>
        <div>duration: {fmtDuration(data.duration_sec)}</div>
        {bullets.outcome && <div>outcome: {bullets.outcome}</div>}
      </header>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {Object.entries(bullets.events ?? {}).map(([k, n]) => (
          <div
            key={k}
            className="bg-muted border border-border rounded px-2 py-1 text-xs flex justify-between"
          >
            <span className="text-subtle">{k}</span>
            <span className="text-accent">{String(n)}</span>
          </div>
        ))}
      </section>

      <section className="bg-surface border border-border rounded p-4">
        <h2 className="font-semibold mb-2">summary</h2>
        <pre className="text-sm whitespace-pre-wrap">{data.summary_md}</pre>
      </section>
    </div>
  );
}
