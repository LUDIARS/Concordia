import { useEffect, useState } from "react";
import { api, type SessionRow } from "../../api.js";

/** @implements spec/feature/session-message-webui-chat.md — D4 session status overlay */

export function StatusOverlay({ session, onClose }: { session: SessionRow; onClose: () => void }) {
  const [stat, setStat] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.statBySession(session.id)
      .then((result) => {
        if (!cancelled) setStat(result.latest?.payload ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      });
    return () => { cancelled = true; };
  }, [session.id]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4" onClick={onClose}>
      <section
        className="ml-auto max-w-xl rounded border border-border bg-surface p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="float-right" onClick={onClose} aria-label="状態を閉じる">×</button>
        <h2 className="font-semibold">状態</h2>
        <dl className="mt-3 space-y-1 text-sm">
          <StatusField label="repo" value={session.repo_path} />
          <StatusField label="branch" value={session.branch ?? "-"} />
          <StatusField label="task" value={session.current_task ?? "-"} />
          <StatusField label="status" value={session.status} />
          <StatusField label="active repos" value={formatStatusValue(stat?.active_repos)} />
          <StatusField label="context" value={formatStatusValue(stat?.context_tokens)} />
          <StatusField label="cost" value={formatStatusValue(stat?.cost_tokens ?? stat?.cost_usd)} />
        </dl>
        {error && <div className="mt-2 text-xs text-danger">stat load error: {error}</div>}
      </section>
    </div>
  );
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 status overlay */
function StatusField({ label, value }: { label: string; value: string }) {
  return <div className="flex gap-2"><dt className="w-24 shrink-0 text-subtle">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>;
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 status overlay */
function formatStatusValue(value: unknown): string {
  if (value === undefined || value === null) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}
