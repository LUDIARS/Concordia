import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../../api.js";
import type { SessionEvent, SessionRow } from "../../api.js";
import { useLiveQuery, useWsEvent } from "../../hooks/useWsEvent.js";
import { projectCodeFor, repoBasename } from "../../project-codes.js";
import { mergeBySeq, extractRole, extractText, extractClaudeUuid, renderFramePayload, ForkFromButton, kindBadge, type TranscriptFrame } from "./shared.js";

// ─── 2. 作業リポジトリのコード一覧 ───────────────────────────────────────

/**
 * session.repo_path + latest stat の active_repos を集約して、 触っている repo
 * 群を project code chip (2 文字) で並べる. リポ移動が hook + Lictor active-repo
 * relay で stat / repo_path に反映されるので、 ここを見れば現在どこにいるか分かる.
 */
export function ActiveReposPanel({ session }: { session: SessionRow }) {
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

const CONVERSATION_KEEP = 5;
const CONVERSATION_LINE_CLAMP = 3;
export function ConversationPanel({ sessionId }: { sessionId: string }) {
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

export function InjectForm({ sessionId }: { sessionId: string }) {
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
