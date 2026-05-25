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
      {s.status === "active" && <ConversationPanel sessionId={s.id} />}
      {s.status === "active" && <TranscriptPanel sessionId={s.id} />}
      {s.status === "active" && <PermissionModal sessionId={s.id} />}

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

interface PendingPermission {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
}

/**
 * Tool permission gateway. Lictor's PreToolUse hook fires and blocks the
 * wrapped claude until the user decides. We listen for session-targeted
 * permission_request events and surface a modal until the user picks
 * allow / deny. The decision goes back through Concordia → Lictor sidecar
 * (proxied) → the pending hook resolver.
 *
 * If multiple requests stack up (Claude tries to run several tools in one
 * turn), the modal queues them — oldest first.
 */
function PermissionModal({ sessionId }: { sessionId: string }) {
  const [queue, setQueue] = useState<PendingPermission[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useWsEvent(["session.permission_request"], (ev) => {
    if (ev.type !== "session.permission_request") return;
    if (ev.target_session_id !== sessionId) return;
    setQueue((prev) => {
      // Dedupe by request_id in case the same event arrives twice (WS reconnect, retry).
      if (prev.some((p) => p.request_id === ev.request_id)) return prev;
      return [...prev, { request_id: ev.request_id, tool_name: ev.tool_name, tool_input: ev.tool_input }];
    });
  });

  const head = queue[0];
  if (!head) return null;

  const respond = async (decision: "allow" | "deny", reason?: string) => {
    if (sending) return;
    setSending(true);
    setErr(null);
    try {
      await api.permissionRespond(sessionId, { request_id: head.request_id, decision, reason });
      setQueue((prev) => prev.filter((p) => p.request_id !== head.request_id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const preview = previewToolInput(head.tool_input);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-accent rounded p-5 max-w-2xl w-full shadow-lg">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-semibold">ツール実行の許可</h2>
          <span className="text-xs text-subtle ml-auto">
            queue {queue.length} / id {head.request_id.slice(0, 8)}…
          </span>
        </div>
        <div className="text-sm mb-2">
          <span className="font-mono text-accent">{head.tool_name}</span>
          <span className="text-subtle"> を実行しようとしています</span>
        </div>
        <pre className="bg-muted px-3 py-2 rounded text-[11px] font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {preview}
        </pre>
        {err && <div className="mt-2 text-xs text-danger">{err}</div>}
        <div className="mt-4 flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => respond("deny", "ユーザが拒否")}
            disabled={sending}
            className="px-3 py-1.5 bg-danger/80 text-white rounded text-sm disabled:opacity-50"
          >
            拒否
          </button>
          <button
            type="button"
            onClick={() => respond("allow")}
            disabled={sending}
            className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
          >
            {sending ? "送信中…" : "許可"}
          </button>
        </div>
      </div>
    </div>
  );
}

function previewToolInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 1000);
  try {
    const s = JSON.stringify(input, null, 2) ?? "";
    return s.length > 1500 ? s.slice(0, 1500) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

interface TranscriptFrame {
  seq: number;
  kind: string;
  payload: unknown;
  ts: number;
}

/**
 * 会話パネル — transcript.frame のうち user prompt / assistant reply の text
 * フレームだけを抽出して、 「ユーザが何を頼んで AI が何を返したか」 だけを
 * 読みやすく並べる主要ビュー. tool-use / tool-result / thinking / system /
 * raw 等のデバッグ系は TranscriptPanel (下) でトグル展開する.
 *
 * 永続化: backend (transcript_logs table) に全 frame が保存されているので、
 * mount 時に GET /v1/sessions/:id/transcript で過去ログを読み出して seed する.
 * 以降の新 frame は WS で来る. seq で dedup するので fetch と WS の境目で
 * 重複しても安全.
 */
function ConversationPanel({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<TranscriptFrame[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // sessionId 切替時に前 session の turns を絶対に持ち越さない. mergeBySeq は
    // seq 単位で dedup するが seq は session ごとにリセットされる (= 別 session の
    // seq=5 同士が衝突して取りこぼし / 残留が起こる) ため、 state そのものを 0 から
    // 組み直す必要がある.
    setTurns([]);
    void api.sessionTranscript(sessionId, { limit: 200 })
      .then((res) => {
        if (cancelled) return;
        const seeded = res.entries
          .filter((e) => e.kind === "text")
          .filter((e) => {
            const r = extractRole(e.payload);
            return r === "user" || r === "assistant";
          })
          .map((e) => ({ seq: e.seq, kind: e.kind, payload: e.payload, ts: e.ts }));
        setTurns(seeded.slice(-100));
      })
      .catch(() => {
        /* backend が古い / endpoint 未配備 — WS-only にフォールバック */
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  useWsEvent(["transcript.frame"], (ev) => {
    if (ev.type !== "transcript.frame") return;
    if (ev.target_session_id !== sessionId) return;
    if (ev.kind !== "text") return;
    const role = extractRole(ev.payload);
    if (role !== "user" && role !== "assistant") return;
    setTurns((prev) =>
      mergeBySeq(prev, [{ seq: ev.seq, kind: ev.kind, payload: ev.payload, ts: ev.ts }]).slice(-100),
    );
  });

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns.length]);

  return (
    <section className="bg-surface border border-border rounded p-4">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-base font-semibold">会話</h2>
        <span className="text-xs text-subtle">
          ユーザ指示 + AI 応答のみ ({turns.length}/100)
        </span>
      </div>
      {turns.length === 0 ? (
        <div className="text-xs text-subtle">
          まだ会話フレームを受信していません. 指示を送るかセッションを開始してください.
        </div>
      ) : (
        <div ref={scrollRef} className="max-h-[32rem] overflow-y-auto space-y-2">
          {turns.map((f) => {
            const role = extractRole(f.payload) ?? "?";
            const text = extractText(f.payload) ?? "";
            const claudeUuid = extractClaudeUuid(f.payload);
            const isUser = role === "user";
            return (
              <div
                key={f.seq}
                className={`rounded border px-3 py-2 ${
                  isUser
                    ? "bg-accent/5 border-accent/30"
                    : "bg-muted/40 border-border"
                }`}
              >
                <div className="flex items-center gap-2 text-[11px] text-subtle">
                  <span className={isUser ? "text-accent font-semibold" : "text-ok font-semibold"}>
                    {isUser ? "user" : "assistant"}
                  </span>
                  <span>#{f.seq}</span>
                  {claudeUuid && (
                    <ForkFromButton sessionId={sessionId} claudeUuid={claudeUuid} />
                  )}
                  <span className="ml-auto">{fmtTs(f.ts)}</span>
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-words text-xs font-sans leading-relaxed">
                  {text}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * 既存 frames に incoming frames を seq dedup でマージ. 同 seq があれば既存を
 * 優先 (= incoming 側の重複を捨てる). 並びは ts ASC + seq ASC で揃える.
 * fetch (history) と WS (live) の境目で同じ frame が両経路から来ても 1 件に
 * 収まる.
 */
function mergeBySeq(existing: TranscriptFrame[], incoming: TranscriptFrame[]): TranscriptFrame[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((f) => f.seq));
  const added = incoming.filter((f) => !seen.has(f.seq));
  if (added.length === 0) return existing;
  const merged = [...existing, ...added];
  merged.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return merged;
}

function extractRole(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as { role?: unknown }).role;
  return typeof v === "string" ? v : null;
}

function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as { text?: unknown }).text;
  return typeof v === "string" ? v : null;
}

/**
 * Live transcript pane — subscribes to `transcript.frame` events from
 * Lictor (relayed by Concordia) for this session. Renders the last N
 * frames; no persistence (a page reload starts empty until new frames
 * arrive). v1 rendering is intentionally minimal: kind badge + JSON dump.
 *
 * 本ビューは tool-use / tool-result / thinking / system / raw 等のデバッグ系
 * を含む全フレームを raw 表示する補助要素. デフォルトは折り畳み. 会話の流れだけ
 * を見たいときは上の ConversationPanel を使う.
 */
function TranscriptPanel({ sessionId }: { sessionId: string }) {
  const [frames, setFrames] = useState<TranscriptFrame[]>([]);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    // ConversationPanel と同様、 sessionId 切替で前 session の frames を捨てる.
    setFrames([]);
    void api.sessionTranscript(sessionId, { limit: 200 })
      .then((res) => {
        if (cancelled) return;
        const seeded = res.entries.map((e) => ({
          seq: e.seq,
          kind: e.kind,
          payload: e.payload,
          ts: e.ts,
        }));
        setFrames(seeded.slice(-200));
      })
      .catch(() => { /* WS-only fallback */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  useWsEvent(["transcript.frame"], (ev) => {
    if (ev.type !== "transcript.frame") return;
    if (ev.target_session_id !== sessionId) return;
    setFrames((prev) =>
      mergeBySeq(prev, [{ seq: ev.seq, kind: ev.kind, payload: ev.payload, ts: ev.ts }]).slice(-200),
    );
  });

  useEffect(() => {
    if (!expanded) return;
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [frames.length, expanded]);

  const thinking = derivesThinking(frames);

  return (
    <section className="bg-surface border border-border rounded p-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted"
          title={expanded ? "閉じる" : "展開する"}
        >
          {expanded ? "▼" : "▶"}
        </button>
        <h2 className="text-base font-semibold">transcript (raw)</h2>
        <ThinkingDot active={thinking} />
        <span className="text-xs text-subtle">
          tool-use / tool-result / thinking 含む全フレーム ({frames.length}/200)
        </span>
      </div>
      {expanded && (
        <div className="mt-2">
          {frames.length === 0 ? (
            <div className="text-xs text-subtle">
              まだフレームを受信していません。 Lictor v0.5 以降がラップしているセッションでのみ流れます。
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="max-h-96 overflow-y-auto space-y-1 font-mono text-[11px]"
            >
              {frames.map((f) => {
                const claudeUuid = extractClaudeUuid(f.payload);
                return (
                  <div key={f.seq} className="border-l-2 border-border pl-2 py-1">
                    <div className="flex items-center gap-2 text-subtle">
                      <span className="text-accent">{f.kind}</span>
                      <span>#{f.seq}</span>
                      {claudeUuid && (
                        <ForkFromButton sessionId={sessionId} claudeUuid={claudeUuid} />
                      )}
                      <span className="ml-auto">{fmtTs(f.ts)}</span>
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-[11px]">
                      {renderFramePayload(f.kind, f.payload)}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function extractClaudeUuid(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as { claude_uuid?: unknown }).claude_uuid;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Per-frame "fork from here" trigger. Spawns a new lictor wrapped claude
 * with --resume <uuid>, running in the same cwd as the parent session
 * (server fills in parent.repo_path). Confirms before firing because the
 * action opens a new Windows Terminal tab.
 */
function ForkFromButton({ sessionId, claudeUuid }: { sessionId: string; claudeUuid: string }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    if (busy) return;
    if (!confirm(`このメッセージから fork します (${claudeUuid.slice(0, 8)}…) — 新タブで lictor wrapped claude が起動します`)) return;
    setBusy(true);
    try {
      await api.sessionFork(sessionId, { claude_uuid: claudeUuid });
    } catch (e) {
      alert(`fork failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={click}
      disabled={busy}
      title={`fork from ${claudeUuid}`}
      className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/40 disabled:opacity-50"
    >
      {busy ? "…" : "🔱 fork"}
    </button>
  );
}

/**
 * Derive "claude is thinking" from the transcript frame history. We use
 * the role of the most recent text/tool-result frame:
 *  - last frame role=user OR kind=tool-result  → claude is responding
 *    (it sees new input and hasn't written its assistant message yet)
 *  - last frame role=assistant text             → idle
 *
 * Latency is bounded by how often Claude flushes the JSONL — typically
 * each turn at message-end. So the indicator is "responded recently" not
 * sub-second, but it's still useful for the dashboard. HAPPY's
 * fetch-interception approach gives sub-second precision; we trade that
 * for zero new IPC.
 */
function derivesThinking(frames: TranscriptFrame[]): boolean {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.kind === "tool-result") return true;
    if (f.kind === "text") {
      const role = (f.payload as { role?: string } | null)?.role;
      if (role === "assistant") return false;
      if (role === "user") return true;
    }
    if (f.kind === "thinking") return true;
  }
  return false;
}

function ThinkingDot({ active }: { active: boolean }) {
  return (
    <span
      title={active ? "claude が応答中" : "idle"}
      className={`inline-block w-2 h-2 rounded-full ${active ? "bg-accent animate-pulse" : "bg-subtle/40"}`}
    />
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
