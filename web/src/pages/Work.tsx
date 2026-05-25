/**
 * Work — 横断作業ログビュー.
 *
 * - 1 リクエスト (GET /v1/work/conversations) で 全 / repo-filter された session
 *   群の conversation (text + user/assistant) を引っぱってきて並べる.
 * - 上部に repo chip を出し、 クリックで filter on/off.
 * - WS の transcript.frame / session.ended / session.started で自動 refetch.
 *
 * SessionDetail の ConversationPanel は「1 session 限定 + 詳細」、 こちらは
 * 「全体俯瞰 + repo フィルタ」 という棲み分け.
 */

import { Link } from "react-router-dom";
import { useState } from "react";
import { api, fmtTs, statusBadge } from "../api.js";
import { useLiveQuery } from "../hooks/useWsEvent.js";

export function Work() {
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const { data, error, refetch } = useLiveQuery(
    () =>
      api.workConversations({
        repo_path: repoPath ?? undefined,
        limit_per_session: 50,
        max_sessions: 30,
      }),
    ["transcript.frame", "session.started", "session.ended", "session.lost"],
    repoPath ?? "__all__",
  );

  if (error) return <div className="text-danger">load error: {error.message}</div>;
  if (!data) return <div className="text-subtle">loading…</div>;

  const totalTurns = data.sessions.reduce((acc, s) => acc + s.conversation.length, 0);

  return (
    <div className="space-y-4">
      <header className="bg-surface border border-border rounded p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">Work</h1>
          <span className="text-xs text-subtle">
            全セッションのユーザ指示 + AI 応答 ({data.sessions.length} session / {totalTurns} turns)
          </span>
          <button
            type="button"
            onClick={() => refetch()}
            className="ml-auto px-2 py-0.5 border border-border rounded text-xs hover:bg-muted"
            title="再取得"
          >
            ↻
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-subtle">repo:</span>
          <RepoChip
            label="(全て)"
            active={repoPath === null}
            count={data.available_repos.reduce((acc, r) => acc + r.session_count, 0)}
            onClick={() => setRepoPath(null)}
          />
          {data.available_repos.map((r) => (
            <RepoChip
              key={r.repo_path}
              label={shortRepo(r.repo_path)}
              active={repoPath === r.repo_path}
              count={r.session_count}
              onClick={() => setRepoPath(r.repo_path)}
              title={r.repo_path}
            />
          ))}
        </div>
      </header>

      {data.sessions.length === 0 ? (
        <div className="text-subtle text-sm">
          該当する session の会話ログが見つかりません。 repo filter を緩めるか、 別 session で発話してください。
        </div>
      ) : (
        <div className="space-y-3">
          {data.sessions.map((entry) => (
            <SessionConversationCard key={entry.session.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoChip({
  label,
  active,
  count,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  count: number;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`px-2 py-0.5 border rounded text-xs ${
        active
          ? "bg-accent/20 border-accent text-accent"
          : "bg-muted border-border text-subtle hover:text-text"
      }`}
    >
      {label} <span className={active ? "ml-1 text-accent" : "ml-1 text-subtle"}>×{count}</span>
    </button>
  );
}

function SessionConversationCard({
  entry,
}: {
  entry: {
    session: import("../api.js").SessionRow;
    conversation: Array<{ id: number; seq: number; ts: number; kind: string; payload: unknown }>;
  };
}) {
  const [expanded, setExpanded] = useState(true);
  const { session, conversation } = entry;
  const role = (session.metadata as any)?.role_label ?? "雑用係";

  return (
    <section className="bg-surface border border-border rounded p-3">
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="px-1.5 py-0.5 rounded border border-border hover:bg-muted"
          title={expanded ? "閉じる" : "展開"}
        >
          {expanded ? "▼" : "▶"}
        </button>
        <span className={`px-1.5 py-0.5 rounded ${statusBadge(session.status)}`}>{session.status}</span>
        <Link
          to={`/sessions/${encodeURIComponent(session.id)}`}
          className="text-accent hover:underline font-mono"
          title={session.id}
        >
          {session.id.slice(0, 12)}…
        </Link>
        <span className="text-subtle">{role}</span>
        <span className="text-subtle font-mono">{shortRepo(session.repo_path)}</span>
        {session.branch && (
          <span className="px-1 py-0.5 bg-muted rounded font-mono text-[10px]">{session.branch}</span>
        )}
        <span className="ml-auto text-subtle">
          {conversation.length} turn / {fmtTs(session.last_seen_at)}
        </span>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2">
          {conversation.length === 0 ? (
            <div className="text-xs text-subtle">会話なし</div>
          ) : (
            conversation.map((e) => {
              const role = extractRole(e.payload);
              const text = extractText(e.payload) ?? "";
              const isUser = role === "user";
              return (
                <div
                  key={e.id}
                  className={`rounded border px-3 py-2 ${
                    isUser
                      ? "bg-accent/5 border-accent/30"
                      : "bg-muted/40 border-border"
                  }`}
                >
                  <div className="flex items-center gap-2 text-[11px] text-subtle">
                    <span
                      className={
                        isUser
                          ? "text-accent font-semibold"
                          : "text-ok font-semibold"
                      }
                    >
                      {isUser ? "user" : "assistant"}
                    </span>
                    <span>#{e.seq}</span>
                    <span className="ml-auto">{fmtTs(e.ts)}</span>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap break-words text-xs font-sans leading-relaxed">
                    {text}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

function shortRepo(p: string): string {
  // 末尾 1〜2 階層だけ. E:\Document\Ars\Lictor → "Ars/Lictor"
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
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
