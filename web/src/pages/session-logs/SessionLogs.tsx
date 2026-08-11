import { Link, useParams } from "react-router-dom";
import { api } from "../../api.js";
import { useLiveQuery } from "../../hooks/useWsEvent.js";
import { SessionActivityPanel } from "../session-detail/SessionActivityPanel.js";
import { EventLogToggle, LatestStatPanel, TranscriptPanel } from "../session-detail/SessionControls.js";
import { AskUserQuestionModal, PermissionModal } from "../session-detail/SessionModals.js";

/** @implements spec/feature/session-message-webui-chat.md — D5 raw session logs */

export function SessionLogs() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useLiveQuery(
    () => id ? api.session(id) : Promise.reject(new Error("session id missing")),
    ["session.event", "transcript.frame"],
    id,
  );
  if (!id) return <div>session id missing</div>;
  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;
  return (
    <div className="max-w-6xl space-y-4">
      <header className="flex items-center gap-3">
        <Link to={`/sessions/${encodeURIComponent(id)}`} className="text-accent">← チャット</Link>
        <h1 className="font-semibold">ログ確認</h1>
      </header>
      <section className="rounded border border-border bg-surface p-3 text-sm">
        <div>repo: {data.session.repo_path}</div>
        <div>branch: {data.session.branch ?? "-"}</div>
        <div>status: {data.session.status}</div>
      </section>
      <LatestStatPanel sessionId={id} />
      <SessionActivityPanel sessionId={id} />
      <EventLogToggle events={data.events} />
      <TranscriptPanel sessionId={id} />
      {data.session.status === "active" && (
        <>
          <PermissionModal sessionId={id} />
          <AskUserQuestionModal sessionId={id} events={data.events} />
        </>
      )}
    </div>
  );
}
