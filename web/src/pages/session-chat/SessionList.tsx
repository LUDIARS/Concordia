import { Link } from "react-router-dom";
// @spec セッションの設計・開始確認・実装・調整
import { useState, type ReactNode } from "react";
import type { Department, SessionRow, SubsidiarySummary } from "../../api.js";
import { SessionSpawnDialog } from "./SessionSpawnDialog.js";
import { SessionWorkPhaseBadge } from "./SessionWorkPhase.js";
import { sessionCategories, type SessionCategory } from "./session-categories.js";

/** @implements spec/feature/session-message-webui-chat.md — D4 session sidebar and unread badges */

/** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
export function SessionList({ sessions, activeId, unread, departments = [], companies = [], basePath = "/sessions" }: {
  sessions: SessionRow[]; activeId?: string; unread: Map<string, number>;
  departments?: Department[]; companies?: SubsidiarySummary[]; basePath?: string;
}) {
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = sessions.filter((session) => `${session.current_task ?? ""} ${session.id} ${session.branch ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return (
    <nav className="space-y-3 p-3" aria-label="セッション一覧">
      <div className="flex items-center justify-between px-1 pt-2"><h2 className="text-base font-semibold">職場</h2><span className="text-xs text-subtle">{sessions.length} チャット</span></div>
      <input aria-label="チャットを検索" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="チャットを検索" />
      {sessionCategories(filtered, departments, companies).map((category) => (
        <SessionCategorySection key={category.id} category={category} unread={unread}>
      {category.sessions.map((session) => {
        const unreadCount = unread.get(session.id) ?? 0;
        return (
          <Link
            key={session.id}
            to={`${basePath}/${encodeURIComponent(session.id)}`}
            aria-current={session.id === activeId ? "page" : undefined}
            className={`block rounded-lg border px-3 py-3 text-sm ${session.id === activeId ? "border-accent/40 bg-accent/15 text-text" : "border-transparent text-text hover:bg-muted"}`}
          >
            <div className="flex gap-2">
              <span className={session.status === "active" ? "text-ok" : "text-subtle"}>●</span>
              <span className="truncate">{session.current_task || session.id.slice(0, 12)}</span>
              {unreadCount > 0 && (
                <span className="ml-auto rounded-full bg-accent px-1.5 text-xs text-white">{unreadCount}</span>
              )}
            </div>
            <div className="truncate pl-4 text-xs text-subtle">{session.branch ?? session.provider} · <SessionWorkPhaseBadge value={session.work_phase} /></div>
          </Link>
        );
      })}
        </SessionCategorySection>
      ))}
      {filtered.length === 0 && <p className="px-2 py-6 text-center text-sm text-subtle">{search ? "一致するチャットはありません。" : "チャットはありません。"}</p>}
      <button type="button" onClick={() => setSpawnOpen(true)} className="mt-2 block w-full rounded border border-border px-3 py-2 text-left text-sm text-accent hover:bg-muted">＋ 新規セッション</button>
      {spawnOpen && <SessionSpawnDialog onClose={() => setSpawnOpen(false)} />}
    </nav>
  );
}

function SessionCategorySection({ category, unread, children }: {
  category: SessionCategory; unread: Map<string, number>; children: ReactNode;
}) {
  const [open, setOpen] = useState(category.defaultOpen);
  const unreadCount = category.sessions.reduce((total, session) => total + (unread.get(session.id) ?? 0), 0);
  return (
    <section>
      <button type="button" className="flex w-full items-center gap-2 px-2 py-2 text-left text-xs text-subtle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span><span className="min-w-0 flex-1 truncate">{category.label}</span>
        {unreadCount > 0 && <span className="rounded-full bg-accent/20 px-1.5 text-accent" aria-label={`未読 ${unreadCount} 件`}>{unreadCount}</span>}
        <span>{category.sessions.length}</span>
      </button>
      {open && <div className="space-y-1">{children}</div>}
    </section>
  );
}
