import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type SessionMessage } from "../../api.js";
import { useWsEvent } from "../../hooks/useWsEvent.js";
import { ChatInput } from "./ChatInput.js";
import { parseChatCommand } from "./commands.js";
import { MessageList } from "./MessageList.js";
import { clientId, subscribePush } from "./push.js";
import { SessionList } from "./SessionList.js";
import { StatusOverlay } from "./StatusOverlay.js";

/** @implements spec/feature/session-message-webui-chat.md — D4 chat, unread, and push UI */

export function SessionChat() {
  const { id } = useParams<{ id: string }>();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.sessions>>["sessions"]>([]);
  const [session, setSession] = useState<Awaited<ReturnType<typeof api.session>>["session"] | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [unread, setUnread] = useState(new Map<string, number>());
  const [drawer, setDrawer] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const browserId = useMemo(clientId, []);
  const selectedSessionRef = useRef(id);
  const refreshRequestRef = useRef(0);
  selectedSessionRef.current = id;

  const refresh = async () => {
    if (!id) return;
    const requestedId = id;
    const request = ++refreshRequestRef.current;
    try {
      const [sessionData, list, messageData] = await Promise.all([
        api.session(requestedId),
        api.sessions(),
        api.sessionMessages(requestedId),
      ]);
      if (request !== refreshRequestRef.current || selectedSessionRef.current !== requestedId) return;
      setSession(sessionData.session);
      setSessions(list.sessions);
      setMessages(messageData.messages);
      setPageError(null);
    } catch (cause) {
      if (request !== refreshRequestRef.current || selectedSessionRef.current !== requestedId) return;
      setPageError((cause as Error).message);
    }
  };

  useEffect(() => {
    setSession(null);
    setMessages([]);
    setDrawer(false);
    void refresh();
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      sessions.map(async (item) => [item.id, (await api.sessionUnread(item.id, browserId)).unread] as const),
    )
      .then((values) => { if (!cancelled) setUnread(new Map(values)); })
      .catch((cause) => { if (!cancelled) setPageError((cause as Error).message); });
    return () => { cancelled = true; };
  }, [sessions, browserId]);

  const latestMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (!id || latestMessageId === undefined) return;
    let cancelled = false;
    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      void api
        .sessionMarkRead(id, browserId, latestMessageId)
        .then(() => {
          if (!cancelled) setUnread((current) => new Map(current).set(id, 0));
        })
        .catch((cause) => { if (!cancelled) setPageError((cause as Error).message); });
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [id, latestMessageId, browserId]);

  useWsEvent(["session.message", "session.message.summary", "session.started", "session.ended", "session.lost", "session.task_changed", "session.event"], (event) => {
    if (event.type === "session.message" && event.target_session_id === id) {
      setMessages((current) => mergeMessage(current, event.message));
    }
    if (event.type === "session.message.summary") {
      void api
        .sessionUnread(event.target_session_id, browserId)
        .then((result) => setUnread((current) => new Map(current).set(event.target_session_id, result.unread)))
        .catch((cause) => setPageError((cause as Error).message));
    }
    if ((event.type === "session.ended" || event.type === "session.lost" || event.type === "session.event") && event.session_id === id) {
      void refresh();
    }
    if (event.type === "session.started" || event.type === "session.ended" || event.type === "session.lost" || event.type === "session.task_changed") {
      void api.sessions()
        .then((result) => setSessions(result.sessions))
        .catch((cause) => setPageError((cause as Error).message));
    }
  });

  if (!id) return <div className="text-danger">session id missing</div>;

  const submit = async (raw: string): Promise<string | null> => {
    const command = parseChatCommand(raw);
    try {
      if (command.kind === "error") return command.message;
      if (command.kind === "inject" || command.kind === "enter") {
        await api.sessionInject(id, command.kind === "enter" ? "\n" : command.text, "web-ui");
      }
      if (command.kind === "rename") await api.sessionRename(id, command.text);
      if (command.kind === "stat") await api.sessionRequestStat(id);
      if (command.kind === "stop") {
        if (!confirm("このセッションを停止しますか？")) return "停止を取り消しました";
        await api.adminStop(id);
      }
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  const answer = async (message: SessionMessage, value: number | number[]): Promise<void> => {
    const questionId = Number(message.metadata?.question_id);
    if (!Number.isInteger(questionId)) throw new Error("question_id がありません");
    await api.answerQuestion(
      id,
      Array.isArray(value)
        ? { question_id: questionId, answer_indices: value }
        : { question_id: questionId, answer_index: value },
    );
  };
  const permission = async (message: SessionMessage, allow: boolean): Promise<void> => {
    const requestId = message.metadata?.request_id;
    if (typeof requestId !== "string") throw new Error("request_id がありません");
    await api.permissionRespond(id, { request_id: requestId, decision: allow ? "allow" : "deny" });
  };
  const sidebar = <SessionList sessions={sessions} activeId={id} unread={unread} />;

  return (
    <div className="-mx-3 -my-4 flex h-[calc(100vh-8rem)] min-h-[32rem] bg-bg">
      <aside className="hidden w-72 shrink-0 overflow-y-auto border-r border-border md:block">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setDrawer(false)}>
          <aside className="h-full w-72 bg-surface" onClick={(event) => event.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border bg-surface p-3">
          <button type="button" className="md:hidden" onClick={() => setDrawer(true)} aria-label="セッション一覧を開く">☰</button>
          <div className="min-w-0 flex-1 truncate font-semibold">{session?.current_task || id}</div>
          <Link to={`/sessions/${encodeURIComponent(id)}/logs`} className="text-sm text-accent">ログ</Link>
          <button type="button" onClick={() => setStatusOpen(true)} title="状態">ⓘ</button>
          <button
            type="button"
            onClick={() => void subscribePush().then(() => setPushError(null)).catch((error) => setPushError((error as Error).message))}
            title="通知を購読"
          >
            🔔
          </button>
        </header>
        {pageError && <div className="px-3 py-1 text-xs text-danger">更新エラー: {pageError}</div>}
        {pushError && <div className="px-3 text-xs text-danger">{pushError}</div>}
        <MessageList messages={messages} onAnswer={answer} onPermission={permission} />
        <ChatInput onSubmit={submit} disabled={session?.status !== "active"} />
      </section>
      {statusOpen && session && <StatusOverlay session={session} onClose={() => setStatusOpen(false)} />}
    </div>
  );
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 live message updates */
function mergeMessage(current: SessionMessage[], incoming: SessionMessage): SessionMessage[] {
  const found = current.findIndex((message) => message.id === incoming.id);
  if (found >= 0) {
    const next = [...current];
    next[found] = incoming;
    return next;
  }
  return [...current, incoming].sort((left, right) => left.id - right.id);
}
