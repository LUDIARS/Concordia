import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../api.js";
import type { SessionEvent, SessionRow } from "../api.js";
import { useLiveQuery, useWsEvent } from "../hooks/useWsEvent.js";
import { projectCodeFor, repoBasename } from "../project-codes.js";

/**
 * SessionDetail — モバイル / デスクトップ共通の縦スタック.
 *
 *   1. ヘッダ (ロール / セッション情報)
 *   2. 作業リポジトリのコード一覧
 *   3. 直近の会話 5 件 (3 行で省略)
 *   4. テキスト入力 (textarea; Enter=送信, Shift+Enter=改行)
 *   5. 直近 stat
 *   6. 停止 / stat / rename ボタン
 *   7. event log (toggle)
 *   8. transcript log (toggle、 raw 全フレーム)
 */
export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, error, refetch } = useLiveQuery(
    () => api.session(id!),
    [],
    id,
  );

  useWsEvent(["session.event", "session.ended", "session.lost", "report.generated"], (ev) => {
    if ("session_id" in ev && ev.session_id === id) refetch();
  });

  if (!id) return <div>session id missing</div>;
  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  const s = data.session;
  const role = (s.metadata as any)?.role_label ?? "雑用係";
  const lictorPid =
    typeof (s.metadata as any)?.lictor_pid === "number" ? ((s.metadata as any).lictor_pid as number) : null;
  const isActive = s.status === "active";

  return (
    <div className="space-y-4 max-w-4xl">
      <Link to="/" className="text-sm text-subtle hover:text-accent">
        ← back
      </Link>

      {/* 1. ヘッダ */}
      <header className="bg-surface border border-border rounded p-4">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className={`px-1.5 py-0.5 rounded ${statusBadge(s.status)}`}>{s.status}</span>
          <span className="text-subtle">{s.provider}</span>
          <span className="ml-auto text-accent">{role}</span>
        </div>
        <h1 className="mt-2 font-mono text-base break-all">{s.repo_path}</h1>
        <div className="text-xs text-subtle flex flex-wrap gap-x-3 gap-y-1">
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

      {/* 2. 作業リポジトリのコード一覧 */}
      <ActiveReposPanel session={s} />

      {/* 3. 直近の会話 5 件 */}
      <ConversationPanel sessionId={s.id} />

      {/* 4. テキスト入力 (active 時のみ) */}
      {isActive && <InjectForm sessionId={s.id} />}

      {/* 5. 直近 stat */}
      <LatestStatPanel sessionId={s.id} />

      {/* 6. 停止 / stat / rename ボタン (active 時のみ) */}
      {isActive && <ActionButtonRow sessionId={s.id} canStop={lictorPid !== null} onStopped={refetch} />}

      {/* 7. event log (toggle) */}
      <EventLogToggle events={data.events} />

      {/* 8. transcript log (toggle, raw) — active 時のみ意味があるが ended でも履歴は読める */}
      <TranscriptPanel sessionId={s.id} />

      {/* permission modal — active 時のみ */}
      {isActive && <PermissionModal sessionId={s.id} />}
      {isActive && <AskUserQuestionModal sessionId={s.id} events={data.events} />}
    </div>
  );
}

// ─── 2. 作業リポジトリのコード一覧 ───────────────────────────────────────

/**
 * session.repo_path + latest stat の active_repos を集約して、 触っている repo
 * 群を project code chip (2 文字) で並べる. リポ移動が hook + Lictor active-repo
 * relay で stat / repo_path に反映されるので、 ここを見れば現在どこにいるか分かる.
 */
function ActiveReposPanel({ session }: { session: SessionRow }) {
  const stat = useLiveQuery(
    () => api.statBySession(session.id),
    ["stat.collected"],
    session.id,
  );
  const projectCodes = useLiveQuery(() => api.projectCodes(), [], "project-codes");

  const repos = collectRepos(session, stat.data?.latest?.payload);
  return (
    <section className="bg-surface border border-border rounded p-3">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold">作業リポジトリ</h2>
        <span className="text-xs text-subtle">{repos.length} repo</span>
      </div>
      {repos.length === 0 ? (
        <div className="text-xs text-subtle">repo 未検出</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {repos.map((r) => {
            const code = projectCodeFor(r.path, projectCodes.data?.categories ?? []);
            return (
              <span
                key={r.path + "::" + (r.branch ?? "")}
                title={r.path}
                className={`px-2 py-0.5 rounded text-xs border ${
                  r.primary
                    ? "bg-accent/15 border-accent text-accent"
                    : "bg-muted border-border text-subtle"
                }`}
              >
                {code && <span className="font-bold mr-1">[{code}]</span>}
                <span className="font-mono">{repoBasename(r.path) || r.path}</span>
                {r.branch && (
                  <span className="ml-1 text-[10px] opacity-70">@{r.branch}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface RepoEntry { path: string; branch: string | null; primary: boolean }

function collectRepos(session: SessionRow, statPayload: Record<string, unknown> | undefined): RepoEntry[] {
  const out: RepoEntry[] = [];
  const seen = new Set<string>();
  const push = (path: string, branch: string | null, primary: boolean): void => {
    if (!path) return;
    const key = path + "::" + (branch ?? "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, branch, primary });
  };
  // 1. session.repo_path は最有力 (Lictor active-repo relay で常時更新)
  push(session.repo_path, session.branch ?? null, true);
  // 2. 最新 stat の active_repos[] を補完追加
  if (statPayload && Array.isArray((statPayload as { active_repos?: unknown }).active_repos)) {
    const arr = (statPayload as { active_repos: unknown[] }).active_repos;
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const o = it as { repo?: unknown; repo_path?: unknown; branch?: unknown };
      const path = typeof o.repo_path === "string" ? o.repo_path : typeof o.repo === "string" ? o.repo : "";
      const branch = typeof o.branch === "string" ? o.branch : null;
      push(path, branch, false);
    }
  }
  return out;
}

// ─── 3. 会話 (直近 5 件, 3 行で省略) ────────────────────────────────────

interface TranscriptFrame {
  seq: number;
  kind: string;
  payload: unknown;
  ts: number;
}

const CONVERSATION_KEEP = 5;
const CONVERSATION_LINE_CLAMP = 3;

/**
 * 直近 5 件の user prompt / assistant reply だけを抽出して並べる. 各 turn は
 * 3 行で省略 (line-clamp). 全文は title 属性で hover 確認できる.
 */
function ConversationPanel({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<TranscriptFrame[]>([]);

  useEffect(() => {
    let cancelled = false;
    setTurns([]);
    // tail=true: 起動直後の raw frame ではなく直近 200 frame を取得 (最新の作業を表示).
    void api.sessionTranscript(sessionId, { limit: 200, tail: true })
      .then((res) => {
        if (cancelled) return;
        const seeded = res.entries
          .filter((e) => e.kind === "text")
          .filter((e) => {
            const r = extractRole(e.payload);
            return r === "user" || r === "assistant";
          })
          .map((e) => ({ seq: e.seq, kind: e.kind, payload: e.payload, ts: e.ts }));
        setTurns(seeded.slice(-CONVERSATION_KEEP));
      })
      .catch(() => { /* WS-only fallback */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  useWsEvent(["transcript.frame"], (ev) => {
    if (ev.type !== "transcript.frame") return;
    if (ev.target_session_id !== sessionId) return;
    if (ev.kind !== "text") return;
    const role = extractRole(ev.payload);
    if (role !== "user" && role !== "assistant") return;
    setTurns((prev) =>
      mergeBySeq(prev, [{ seq: ev.seq, kind: ev.kind, payload: ev.payload, ts: ev.ts }]).slice(-CONVERSATION_KEEP),
    );
  });

  return (
    <section className="bg-surface border border-border rounded p-3">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold">直近の会話</h2>
        <span className="text-xs text-subtle">{turns.length} / {CONVERSATION_KEEP} (3 行で省略)</span>
      </div>
      {turns.length === 0 ? (
        <div className="text-xs text-subtle">まだ会話がありません.</div>
      ) : (
        <div className="space-y-2">
          {turns.map((f) => {
            const role = extractRole(f.payload) ?? "?";
            const text = extractText(f.payload) ?? "";
            const isUser = role === "user";
            return (
              <div
                key={f.seq}
                className={`rounded border px-3 py-2 ${
                  isUser ? "bg-accent/5 border-accent/30" : "bg-muted/40 border-border"
                }`}
              >
                <div className="flex items-center gap-2 text-[11px] text-subtle">
                  <span className={isUser ? "text-accent font-semibold" : "text-ok font-semibold"}>
                    {isUser ? "user" : "assistant"}
                  </span>
                  <span>#{f.seq}</span>
                  <span className="ml-auto">{fmtTs(f.ts)}</span>
                </div>
                <pre
                  title={text}
                  className="mt-1 whitespace-pre-wrap break-words text-xs font-sans leading-relaxed"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: CONVERSATION_LINE_CLAMP,
                    WebkitBoxOrient: "vertical" as any,
                    overflow: "hidden",
                  }}
                >
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

// ─── 4. テキスト入力 (Enter=送信, Shift+Enter=改行) ────────────────────────

function InjectForm({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const submit = async (): Promise<void> => {
    if (!text.trim() || sending) return;
    setSending(true);
    setStatus(null);
    try {
      await api.sessionInject(sessionId, text, "web-ui");
      setStatus({ kind: "ok", msg: "送信しました" });
      setText("");
    } catch (err) {
      setStatus({ kind: "err", msg: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter = send. Shift+Enter keeps textarea's default newline behavior.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="bg-surface border border-border rounded p-3 space-y-2"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold">指示を送る</h2>
        <span className="text-xs text-subtle">Enter=送信 / Shift+Enter=改行</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder='例: "現状を /stat で報告して" / 改行も入れられます'
        disabled={sending}
        maxLength={4000}
        rows={4}
        className="w-full foundation-form font-mono text-sm resize-y"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!text.trim() || sending}
          className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
        >
          {sending ? "送信中…" : "送信"}
        </button>
        {status && (
          <span className={`text-xs ${status.kind === "ok" ? "text-ok" : "text-danger"}`}>
            {status.msg}
          </span>
        )}
      </div>
    </form>
  );
}

// ─── 5. 直近 stat ──────────────────────────────────────────────────────

function LatestStatPanel({ sessionId }: { sessionId: string }) {
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

function ActionButtonRow({
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

function EventLogToggle({ events }: { events: Array<{ id: number; ts: number; kind: string; payload: unknown }> }) {
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

function TranscriptPanel({ sessionId }: { sessionId: string }) {
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

// ─── permission modal ────────────────────────────────────────────────

interface PendingPermission {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
}

function PermissionModal({ sessionId }: { sessionId: string }) {
  const [queue, setQueue] = useState<PendingPermission[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useWsEvent(["session.permission_request"], (ev) => {
    if (ev.type !== "session.permission_request") return;
    if (ev.target_session_id !== sessionId) return;
    setQueue((prev) => {
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

interface PendingQuestionUi {
  question_id: number;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multi_select: boolean;
  ts: number;
}

const QUESTION_DISPLAY_DELAY_MS = 350;

function AskUserQuestionModal({ sessionId, events }: { sessionId: string; events: SessionEvent[] }) {
  const [queue, setQueue] = useState<PendingQuestionUi[]>([]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [otherText, setOtherText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    setQueue(unansweredQuestionsFromEvents(events));
  }, [events]);

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  useWsEvent(["question.posted", "question.answered", "question.resolved"], (ev) => {
    if (ev.type !== "question.posted" && ev.type !== "question.answered" && ev.type !== "question.resolved") {
      return;
    }
    if (ev.target_session_id !== sessionId) return;
    if (ev.type === "question.posted") {
      const question = normalizeQuestionEvent(ev);
      const timer = window.setTimeout(() => {
        setQueue((prev) => mergeQuestions(prev, [question]));
      }, QUESTION_DISPLAY_DELAY_MS);
      timersRef.current.push(timer);
      return;
    }
    setQueue((prev) => prev.filter((q) => q.question_id !== ev.question_id));
  });

  const head = queue[0] ?? null;

  useEffect(() => {
    setSelected(new Set());
    setOtherText("");
    setErr(null);
  }, [head?.question_id]);

  if (!head) return null;

  const removeHead = (): void => {
    setQueue((prev) => prev.filter((q) => q.question_id !== head.question_id));
  };

  const answerSingle = async (answerIndex: number): Promise<void> => {
    if (sending) return;
    setSending(true);
    setErr(null);
    try {
      await api.answerQuestion(sessionId, { question_id: head.question_id, answer_index: answerIndex });
      removeHead();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const answerMulti = async (): Promise<void> => {
    if (sending || selected.size === 0) return;
    setSending(true);
    setErr(null);
    try {
      await api.answerQuestion(sessionId, {
        question_id: head.question_id,
        answer_indices: Array.from(selected).sort((a, b) => a - b),
      });
      removeHead();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const answerOther = async (): Promise<void> => {
    const text = otherText.trim();
    if (sending || !text) return;
    setSending(true);
    setErr(null);
    try {
      await api.answerQuestion(sessionId, { question_id: head.question_id, other_text: text });
      removeHead();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const resolveLocal = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    setErr(null);
    try {
      await api.resolveQuestion(sessionId, head.question_id);
      removeHead();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const toggle = (idx: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-[60] p-4">
      <div className="bg-surface border border-accent rounded p-5 max-w-2xl w-full shadow-lg">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-base font-semibold">AskUserQuestion</h2>
          <span className="text-xs text-subtle ml-auto">
            queue {queue.length} / id {head.question_id}
          </span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words mb-3">{head.question}</div>
        <div className="space-y-2">
          {head.options.map((opt, idx) => (
            head.multi_select ? (
              <label
                key={`${head.question_id}:${idx}`}
                className="flex gap-2 border border-border rounded px-3 py-2 text-sm hover:border-accent cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(idx)}
                  disabled={sending}
                  onChange={() => toggle(idx)}
                />
                <span>
                  <span className="block font-medium">{opt.label}</span>
                  {opt.description && <span className="block text-xs text-subtle">{opt.description}</span>}
                </span>
              </label>
            ) : (
              <button
                key={`${head.question_id}:${idx}`}
                type="button"
                disabled={sending}
                onClick={() => void answerSingle(idx)}
                className="w-full text-left border border-border rounded px-3 py-2 text-sm hover:border-accent hover:bg-accent/10 disabled:opacity-50"
              >
                <span className="block font-medium">{opt.label}</span>
                {opt.description && <span className="block text-xs text-subtle">{opt.description}</span>}
              </button>
            )
          ))}
        </div>
        {head.multi_select && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={sending || selected.size === 0}
              onClick={() => void answerMulti()}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
            >
              Answer selected
            </button>
          </div>
        )}
        <div className="mt-4 border-t border-border pt-3">
          <label className="text-xs text-subtle" htmlFor="questionOtherText">Other answer</label>
          <textarea
            id="questionOtherText"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            disabled={sending}
            rows={3}
            maxLength={2000}
            className="mt-1 w-full foundation-form text-sm resize-y"
          />
          <div className="mt-2 flex gap-2 justify-end">
            <button
              type="button"
              disabled={sending}
              onClick={() => void resolveLocal()}
              className="px-3 py-1.5 bg-muted border border-border rounded text-sm disabled:opacity-50"
            >
              Already handled
            </button>
            <button
              type="button"
              disabled={sending || !otherText.trim()}
              onClick={() => void answerOther()}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-50"
            >
              Send other
            </button>
          </div>
        </div>
        {err && <div className="mt-2 text-xs text-danger">{err}</div>}
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

// ─── shared helpers ──────────────────────────────────────────────────

function normalizeQuestionOptions(input: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(input)) return [];
  const out: Array<{ label: string; description?: string }> = [];
  for (const item of input) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ label: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const label = (item as { label?: unknown }).label;
    const description = (item as { description?: unknown }).description;
    if (typeof label !== "string" || !label.trim()) continue;
    const opt: { label: string; description?: string } = { label: label.trim() };
    if (typeof description === "string" && description.trim()) opt.description = description.trim();
    out.push(opt);
  }
  return out;
}

function normalizeQuestionEvent(ev: {
  question_id: number;
  question: string;
  options: Array<string | { label: string; description?: string }>;
  multi_select?: boolean;
  ts: number;
}): PendingQuestionUi {
  return {
    question_id: ev.question_id,
    question: ev.question,
    options: normalizeQuestionOptions(ev.options),
    multi_select: !!ev.multi_select,
    ts: ev.ts,
  };
}

function unansweredQuestionsFromEvents(events: SessionEvent[]): PendingQuestionUi[] {
  const closed = new Set<number>();
  const questions = new Map<number, PendingQuestionUi>();
  for (const ev of events) {
    const payload = ev.payload;
    if (ev.kind === "question_answered" || ev.kind === "question_resolved") {
      const qid = Number((payload as { question_id?: unknown } | null)?.question_id);
      if (Number.isInteger(qid)) closed.add(qid);
      continue;
    }
    if (ev.kind !== "pending_question" || !payload || typeof payload !== "object") continue;
    const p = payload as {
      question_id?: unknown;
      question?: unknown;
      options?: unknown;
      multi_select?: unknown;
    };
    const qid = Number(p.question_id);
    if (!Number.isInteger(qid) || typeof p.question !== "string") continue;
    questions.set(qid, {
      question_id: qid,
      question: p.question,
      options: normalizeQuestionOptions(p.options),
      multi_select: !!p.multi_select,
      ts: ev.ts,
    });
  }
  for (const qid of closed) questions.delete(qid);
  return mergeQuestions([], Array.from(questions.values()));
}

function mergeQuestions(existing: PendingQuestionUi[], incoming: PendingQuestionUi[]): PendingQuestionUi[] {
  const byId = new Map<number, PendingQuestionUi>();
  for (const q of existing) byId.set(q.question_id, q);
  for (const q of incoming) byId.set(q.question_id, q);
  return Array.from(byId.values()).sort((a, b) => (a.ts - b.ts) || (a.question_id - b.question_id));
}

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

function extractClaudeUuid(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as { claude_uuid?: unknown }).claude_uuid;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function renderFramePayload(kind: string, payload: unknown): string {
  if (kind === "text" && payload && typeof payload === "object" && "text" in (payload as any)) {
    return String((payload as { text: unknown }).text).slice(0, 800);
  }
  const s = JSON.stringify(payload, null, 2) ?? "";
  return s.length > 800 ? s.slice(0, 800) + "…" : s;
}

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
