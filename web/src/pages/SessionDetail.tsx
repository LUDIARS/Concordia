import { useEffect, useRef, useState } from "react";
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

      {s.status === "active" && <InjectForm sessionId={s.id} />}
      {s.status === "active" && <StopSessionButton sessionId={s.id} onStopped={refetch} />}
      {s.status === "active" && <TranscriptPanel sessionId={s.id} />}

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

interface TranscriptFrame {
  seq: number;
  kind: string;
  payload: unknown;
  ts: number;
}

/**
 * Live transcript pane — subscribes to `transcript.frame` events from
 * Lictor (relayed by Concordia) for this session. Renders the last N
 * frames; no persistence (a page reload starts empty until new frames
 * arrive). v1 rendering is intentionally minimal: kind badge + JSON dump.
 * PR-H may add subagent grouping / diff rendering.
 */
function TranscriptPanel({ sessionId }: { sessionId: string }) {
  const [frames, setFrames] = useState<TranscriptFrame[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useWsEvent(["transcript.frame"], (ev) => {
    if (ev.type !== "transcript.frame") return;
    if (ev.target_session_id !== sessionId) return;
    setFrames((prev) => [...prev.slice(-199), { seq: ev.seq, kind: ev.kind, payload: ev.payload, ts: ev.ts }]);
  });

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [frames.length]);

  return (
    <section className="bg-surface border border-border rounded p-4">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-base font-semibold">transcript</h2>
        <span className="text-xs text-subtle">
          live frames from Claude JSONL via Lictor ({frames.length}/200)
        </span>
      </div>
      {frames.length === 0 ? (
        <div className="text-xs text-subtle">
          まだフレームを受信していません。 Lictor v0.5 以降がラップしているセッションでのみ流れます。
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="max-h-96 overflow-y-auto space-y-1 font-mono text-[11px]"
        >
          {frames.map((f) => (
            <div key={f.seq} className="border-l-2 border-border pl-2 py-1">
              <div className="flex items-center gap-2 text-subtle">
                <span className="text-accent">{f.kind}</span>
                <span>#{f.seq}</span>
                <span className="ml-auto">{fmtTs(f.ts)}</span>
              </div>
              <pre className="mt-1 whitespace-pre-wrap break-words text-[11px]">
                {renderFramePayload(f.kind, f.payload)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Best-effort payload rendering. For `text` kind we show the text field
 * directly (the common case); everything else is JSON-stringified. Caps
 * at 800 chars to keep the pane navigable.
 */
function renderFramePayload(kind: string, payload: unknown): string {
  if (kind === "text" && payload && typeof payload === "object" && "text" in (payload as any)) {
    return String((payload as { text: unknown }).text).slice(0, 800);
  }
  const s = JSON.stringify(payload, null, 2) ?? "";
  return s.length > 800 ? s.slice(0, 800) + "…" : s;
}

/**
 * Inject form: types arbitrary text into the wrapped TUI as user input via
 * Lictor's WS handler. Active sessions only — lost/ended/abandoned have no
 * recipient. Sends `source: "web-ui"` so Lictor / telemetry can distinguish
 * UI-driven injects from other-AI / external-script ones.
 */
function InjectForm({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setStatus(null);
    try {
      await api.sessionInject(sessionId, text, "web-ui");
      setStatus({ kind: "ok", msg: "sent" });
      setText("");
    } catch (err) {
      setStatus({ kind: "err", msg: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-surface border border-border rounded p-4 space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">指示を送る</h2>
        <span className="text-xs text-subtle">
          このセッションの TUI にユーザー入力として注入されます
        </span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='例: "現状を /stat で報告して" / 先頭が / ならスラッシュコマンド'
          disabled={sending}
          maxLength={4000}
          className="flex-1 foundation-form font-mono text-sm"
        />
        <button
          type="submit"
          disabled={!text.trim() || sending}
          className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
        >
          {sending ? "送信中…" : "送信"}
        </button>
      </div>
      {status && (
        <div className={`text-xs ${status.kind === "ok" ? "text-ok" : "text-danger"}`}>
          {status.msg}
        </div>
      )}
    </form>
  );
}

/**
 * Kill the lictor process for this session. The button confirms before
 * firing because the kill is OS-level (taskkill /F /T on Windows, SIGTERM
 * to the process group on POSIX) — claude has no chance to flush pending
 * edits. Active sessions only.
 */
function StopSessionButton({ sessionId, onStopped }: { sessionId: string; onStopped: () => void }) {
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const stop = async () => {
    if (!confirm("このセッションを強制終了しますか? (lictor + claude が即 kill されます)")) return;
    setSending(true);
    setErr(null);
    try {
      await api.adminStop(sessionId);
      onStopped();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-surface border border-border rounded p-4 flex items-center gap-3">
      <button
        type="button"
        onClick={stop}
        disabled={sending}
        className="px-3 py-1.5 bg-danger text-white rounded text-sm disabled:opacity-50"
      >
        {sending ? "停止中…" : "セッション停止"}
      </button>
      <span className="text-xs text-subtle">
        lictor を kill して claude を強制終了 (タブは閉じない)
      </span>
      {err && <span className="text-xs text-danger ml-auto">{err}</span>}
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
    case "inject":  return `${base} bg-accent/30 text-accent`;
    default:        return `${base} bg-muted text-subtle`;
  }
}
