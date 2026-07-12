import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../../api.js";
import type { SessionEvent, SessionRow } from "../../api.js";
import { useLiveQuery, useWsEvent } from "../../hooks/useWsEvent.js";
import { projectCodeFor, repoBasename } from "../../project-codes.js";
import { mergeBySeq, extractRole, extractText, extractClaudeUuid, renderFramePayload, ForkFromButton, kindBadge, type TranscriptFrame } from "./shared.js";

// ─── 5. 直近 stat ──────────────────────────────────────────────────────

export function LatestStatPanel({ sessionId }: { sessionId: string }) {
  const { data } = useLiveQuery(
    () => api.statBySession(sessionId),
    ["stat.collected"],
    sessionId,
  );
  const latest = data?.latest ?? null;

  return (
    <section className="bg-surface border border-border rounded p-3">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold">直近の stat</h2>
        {latest && <span className="text-xs text-subtle">{fmtTs(latest.ts)}</span>}
      </div>
      {!latest ? (
        <div className="text-xs text-subtle">まだ stat が投稿されていません.</div>
      ) : (
        <StatPayloadView payload={latest.payload} />
      )}
    </section>
  );
}

function StatPayloadView({ payload }: { payload: Record<string, unknown> }) {
  const fields: Array<{ key: string; label: string }> = [
    { key: "todos_summary", label: "todos" },
    { key: "recent_work", label: "recent" },
    { key: "open_prs", label: "open PRs" },
    { key: "unmerged_branches", label: "unmerged" },
    { key: "active_repos", label: "active repos" },
    { key: "note", label: "note" },
  ];
  return (
    <dl className="space-y-1 text-xs">
      {fields.map((f) => {
        const v = payload[f.key];
        if (v === undefined || v === null) return null;
        return (
          <div key={f.key} className="flex gap-2">
            <dt className="text-subtle font-mono shrink-0 w-24">{f.label}</dt>
            <dd className="font-mono whitespace-pre-wrap break-words flex-1">
              {typeof v === "string" ? v : JSON.stringify(v, null, 0)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// ─── 6. 停止 / stat / rename ボタン群 ──────────────────────────────────

export function ActionButtonRow({
  sessionId,
  canStop,
  onStopped,
}: {
  sessionId: string;
  canStop: boolean;
  onStopped: () => void;
}) {
  const [busy, setBusy] = useState<"stop" | "stat" | "rename" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const stop = async () => {
    if (!confirm("このセッションを強制終了しますか? (lictor + claude が即 kill されます)")) return;
    setBusy("stop");
    setMsg(null);
    try {
      await api.adminStop(sessionId);
      onStopped();
      setMsg({ kind: "ok", text: "停止しました" });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const requestStat = async () => {
    setBusy("stat");
    setMsg(null);
    try {
      const r = await api.sessionRequestStat(sessionId);
      setMsg({
        kind: "ok",
        text: r.enqueued ? "stat を依頼しました" : "既に依頼中です",
      });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const requestRename = async () => {
    setBusy("rename");
    setMsg(null);
    try {
      const r = await api.sessionRequestTitle(sessionId);
      setMsg({
        kind: "ok",
        text: r.enqueued ? "rename を依頼しました" : "既に依頼中です",
      });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="bg-surface border border-border rounded p-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={stop}
          disabled={!canStop || busy !== null}
          className="px-3 py-1.5 bg-danger text-white rounded text-sm disabled:opacity-50"
          title={canStop ? "lictor を kill して claude を強制終了" : "lictor_pid が無いセッションは停止できません"}
        >
          {busy === "stop" ? "停止中…" : "停止"}
        </button>
        <button
          type="button"
          onClick={requestStat}
          disabled={busy !== null}
          className="px-3 py-1.5 bg-muted border border-border rounded text-sm hover:border-accent disabled:opacity-50"
          title="AI に最新 stat を投稿させる"
        >
          {busy === "stat" ? "依頼中…" : "stat 依頼"}
        </button>
        <button
          type="button"
          onClick={requestRename}
          disabled={busy !== null}
          className="px-3 py-1.5 bg-muted border border-border rounded text-sm hover:border-accent disabled:opacity-50"
          title="AI に現在の作業を 30 文字で要約させてタイトル更新"
        >
          {busy === "rename" ? "依頼中…" : "rename 依頼"}
        </button>
        {msg && (
          <span className={`ml-auto text-xs self-center ${msg.kind === "ok" ? "text-ok" : "text-danger"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

// ─── 7. event log (toggle) ────────────────────────────────────────────

export function EventLogToggle({ events }: { events: Array<{ id: number; ts: number; kind: string; payload: unknown }> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="bg-surface border border-border rounded p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted"
          title={expanded ? "閉じる" : "展開する"}
        >
          {expanded ? "▼" : "▶"}
        </button>
        <h2 className="text-sm font-semibold">event log</h2>
        <span className="text-xs text-subtle">{events.length} 件</span>
      </div>
      {expanded && (
        <ul className="mt-2 space-y-1">
          {events.map((ev) => (
            <li key={ev.id} className="bg-muted/40 border border-border rounded px-3 py-2 text-xs">
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
      )}
    </section>
  );
}

// ─── 8. transcript log (toggle, raw) ──────────────────────────────────

export function TranscriptPanel({ sessionId }: { sessionId: string }) {
  const [frames, setFrames] = useState<TranscriptFrame[]>([]);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFrames([]);
    // tail=true: 起動直後の raw frame ではなく直近 200 frame を取得 (最新の作業を表示).
    void api.sessionTranscript(sessionId, { limit: 200, tail: true })
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

  return (
    <section className="bg-surface border border-border rounded p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted"
          title={expanded ? "閉じる" : "展開する"}
        >
          {expanded ? "▼" : "▶"}
        </button>
        <h2 className="text-sm font-semibold">transcript log</h2>
        <span className="text-xs text-subtle">
          tool-use / thinking / system 含む全フレーム ({frames.length}/200)
        </span>
      </div>
      {expanded && (
        <div className="mt-2">
          {frames.length === 0 ? (
            <div className="text-xs text-subtle">フレーム未受信.</div>
          ) : (
            <div ref={scrollRef} className="max-h-96 overflow-y-auto space-y-1 font-mono text-[11px]">
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
