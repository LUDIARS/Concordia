import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, type SessionMessage } from "../../api.js";
import { useLiveQuery, useWsEvent } from "../../hooks/useWsEvent.js";
import { useTeamFilter } from "../../lib/TeamFilterContext.js";
import { ChatInput } from "./ChatInput.js";
import { parseChatCommand } from "./commands.js";
import { MessageList } from "./MessageList.js";
import { clientId, subscribePush } from "./push.js";
import { SessionList } from "./SessionList.js";
import { StatusOverlay } from "./StatusOverlay.js";
import { loadAttachmentMessages, type AttachmentMessage } from "./Attachments.js";
import { isResponseWorking } from "./response-turns.js";
import { SessionWorkPanel } from "./SessionWorkPanel.js";
import { visibleChatMessages } from "./message-presentation.js";

/** @implements spec/feature/session-message-webui-chat.md — D4 chat, unread, and push UI */

// @spec セッションの設計・開始確認・実装・調整
export function SessionChat() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { teamId } = useTeamFilter();
  const list = useLiveQuery(() => api.sessions({ teamId: teamId ?? undefined }),
    ["hello", "session.started", "session.ended", "session.lost", "session.task_changed", "session.event"], teamId);
  const organizations = useLiveQuery(async () => {
    const [departments, companies] = await Promise.all([
      api.departmentsList({ allOrganizations: true, includeArchived: true }), api.subsidiariesList(),
    ]);
    return { departments: departments.departments, companies: companies.subsidiaries };
  }, ["hello"]);
  const menuSessions = useMemo(() => (list.data?.sessions ?? []).filter((item) => item.status !== "ended" || item.id === id), [list.data, id]);
  const [session, setSession] = useState<Awaited<ReturnType<typeof api.session>>["session"] | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [attachmentMessages, setAttachmentMessages] = useState<AttachmentMessage[]>([]);
  const [unread, setUnread] = useState(new Map<string, number>());
  const [drawer, setDrawer] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [pendingInput, setPendingInput] = useState<{ sessionId: string; after: number } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
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
      const [sessionData, messageData, attachments] = await Promise.all([
        api.session(requestedId),
        api.sessionMessages(requestedId),
        loadAttachmentMessages(requestedId).then(
          (value) => ({ value, error: null }),
          (cause: unknown) => ({ value: null, error: cause instanceof Error ? cause.message : String(cause) }),
        ),
      ]);
      if (request !== refreshRequestRef.current || selectedSessionRef.current !== requestedId) return;
      setSession(sessionData.session);
      setMessages(messageData.messages);
      if (attachments.value) setAttachmentMessages(attachments.value);
      setAttachmentError(attachments.error);
      setPageError(null);
    } catch (cause) {
      if (request !== refreshRequestRef.current || selectedSessionRef.current !== requestedId) return;
      setPageError((cause as Error).message);
    }
  };

  useEffect(() => {
    setSession(null);
    setMessages([]);
    setAttachmentMessages([]);
    setAttachmentError(null);
    setDrawer(false);
    setStatusOpen(false);
    setWorkOpen(false);
    setPendingInput(null);
    void refresh();
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      menuSessions.map(async (item) => [item.id, (await api.sessionUnread(item.id, browserId)).unread] as const),
    )
      .then((values) => { if (!cancelled) setUnread(new Map(values)); })
      .catch((cause) => { if (!cancelled) setPageError((cause as Error).message); });
    return () => { cancelled = true; };
  }, [menuSessions, browserId]);

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

  useWsEvent(["hello", "chat.posted", "session.message", "session.message.summary", "session.started", "session.ended", "session.lost", "session.task_changed", "session.event"], (event) => {
    if (event.type === "hello") void refresh();
    if (event.type === "chat.posted" && event.session_id === id) void refresh();
    if (event.type === "session.message" && event.target_session_id === id) {
      setMessages((current) => mergeMessage(current, event.message));
    }
    if (event.type === "session.message.summary") {
      void api
        .sessionUnread(event.target_session_id, browserId)
        .then((result) => setUnread((current) => new Map(current).set(event.target_session_id, result.unread)))
        .catch((cause) => setPageError((cause as Error).message));
    }
    if ((event.type === "session.ended" || event.type === "session.lost" || event.type === "session.event" || event.type === "session.task_changed") && event.session_id === id) {
      void refresh();
    }
  });

  const sidebar = <SessionList sessions={menuSessions} activeId={id} unread={unread}
    departments={organizations.data?.departments} companies={organizations.data?.companies}
    basePath={location.pathname.startsWith("/workplace") ? "/workplace" : "/sessions"} />;
  const listError = list.error ?? organizations.error;
  const listFeedback = <>
    {listError && <div role="alert" className="px-4 py-2 text-xs text-danger">一覧の取得に失敗: {listError.message} <button type="button" onClick={() => { list.refetch(); organizations.refetch(); }}>再試行</button></div>}
    {!list.data && !list.error && <p role="status" className="px-4 py-2 text-xs text-subtle">チャットを読み込み中…</p>}
  </>;
  if (!id) return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-bg">
      <aside className="min-h-0 w-full shrink-0 overflow-y-auto border-r border-border bg-surface/40 md:w-80">{listFeedback}{sidebar}</aside>
      <section className="hidden flex-1 items-center justify-center px-8 md:flex">
        <div className="max-w-sm text-center"><div className="mb-4 text-3xl text-accent" aria-hidden="true">◈</div><h1 className="text-xl font-semibold">会話から、仕事を進める</h1><p className="mt-3 text-sm text-subtle">チャットを選ぶと、プレイヤーと AI の回答をここで確認できます。</p><p className="mt-2 text-xs text-subtle">新しい仕事は「新規セッション」から始められます。</p></div>
      </section>
    </div>
  );

  const submit = async (raw: string): Promise<string | null> => {
    const command = parseChatCommand(raw);
    try {
      if (command.kind === "error") return command.message;
      if (command.kind === "inject" || command.kind === "enter") {
        const after = messages[messages.length - 1]?.id ?? 0;
        await api.sessionInject(id, command.kind === "enter" ? "\n" : command.text, "web-ui");
        if (selectedSessionRef.current === id) setPendingInput({ sessionId: id, after });
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
    if (selectedSessionRef.current === id) setPendingInput({ sessionId: id, after: messages[messages.length - 1]?.id ?? 0 });
  };
  /** @implements SPEC-SESSION-CHAT-RESPONSE-WORK */
  const permission = async (message: SessionMessage, allow: boolean): Promise<void> => {
    const requestId = message.metadata?.request_id;
    if (typeof requestId !== "string") throw new Error("request_id がありません");
    await api.permissionRespond(id, { request_id: requestId, decision: allow ? "allow" : "deny" });
    if (selectedSessionRef.current === id) setPendingInput({ sessionId: id, after: messages[messages.length - 1]?.id ?? 0 });
  };
  const department = organizations.data?.departments.find((item) => item.id === session?.department_id);
  const displayMessages = visibleChatMessages(messages, department?.effective_output ?? {});
  const displayReady = !session?.department_id || !!organizations.data;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-bg" style={{ touchAction: "manipulation" }}>
      <aside className="hidden min-h-0 w-80 shrink-0 overflow-y-auto overscroll-contain border-r border-border bg-surface/40 md:block">{listFeedback}{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setDrawer(false)}>
          <aside className="h-full w-72 overflow-y-auto overscroll-contain bg-surface" onClick={(event) => event.stopPropagation()}>
            {listFeedback}{sidebar}
          </aside>
        </div>
      )}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface p-3 sm:px-5">
          <button type="button" className="md:hidden" onClick={() => setDrawer(true)} aria-label="セッション一覧を開く">☰</button>
          <div className="min-w-0 flex-1"><div className="truncate font-semibold">{session?.current_task || id}</div><div className="mt-0.5 text-xs text-subtle">{department?.name ?? "チャット"} · <span className="text-emerald-300">プレイヤー</span><span className="mx-1">/</span><span className="text-violet-300">AI</span></div></div>
          <Link to={`/sessions/${encodeURIComponent(id)}/logs`} className="text-sm text-accent">ログ</Link>
          <button type="button" disabled={!session} aria-expanded={workOpen} aria-controls="session-work-panel" onClick={() => setWorkOpen((open) => !open)} className="shrink-0 rounded border border-border px-2 py-1 text-xs text-accent">タスク・テスト/PR</button>
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
        {organizations.error && <div role="alert" className="px-3 py-1 text-xs text-danger">部署の表示設定を取得できません: {organizations.error.message} <button type="button" onClick={organizations.refetch}>再試行</button></div>}
        {department?.settings_error && <div role="alert" className="px-3 py-1 text-xs text-danger">部署の表示設定を読み込めません: {department.settings_error}</div>}
        {department?.effective_output?.intermediate === false && <div className="border-b border-border px-4 py-2 text-xs text-subtle">部署の設定により、途中経過を省略して回答を表示しています。</div>}
        {attachmentError && <div role="alert" className="px-3 py-1 text-xs text-danger">{attachmentError} <button type="button" onClick={() => void refresh()}>再試行</button></div>}
        {pushError && <div className="px-3 text-xs text-danger">{pushError}</div>}
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {displayReady ? <MessageList messages={displayMessages} attachmentMessages={attachmentMessages} sessionId={id} working={isResponseWorking(messages, session?.status, pendingInput?.sessionId === id ? pendingInput.after : null)} onAnswer={answer} onPermission={permission} />
            : <p role="status" className="p-5 text-sm text-subtle">部署の表示設定を読み込み中…</p>}
          {workOpen && session && <SessionWorkPanel key={id} session={session} onClose={() => setWorkOpen(false)} />}
        </div>
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
