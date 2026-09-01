import { useState } from "react";
import { Link } from "react-router-dom";
import { fmtTs, type SessionMessage } from "../../api.js";

/** @implements spec/feature/session-message-webui-chat.md — D4 author-type rendering */

export function MessageItem({ message, onAnswer, onPermission }: {
  message: SessionMessage;
  onAnswer: (message: SessionMessage, value: number | number[]) => Promise<void>;
  onPermission: (message: SessionMessage, allow: boolean) => Promise<void>;
}) {
  if (message.author_type === "thinking") return <ThinkingMessage message={message} />;
  if (message.author_type === "task") return <TaskMessage message={message} />;
  if (message.author_type === "delegation") return <DelegationMessage message={message} />;
  if (message.author_type === "question") return <QuestionMessage message={message} onAnswer={onAnswer} />;
  if (message.author_type === "permission") return <PermissionMessage message={message} onPermission={onPermission} />;
  if (message.author_type === "tool") {
    const failure = toolFailure(message);
    if (failure) return <ToolFailureMessage message={message} failure={failure} />;
  }
  return <article className="rounded px-2 py-1.5 hover:bg-muted/50"><div className="text-xs text-subtle">{message.author_label} · {fmtTs(message.ts)}</div><div className="whitespace-pre-wrap break-words">{message.content}</div></article>;
}

/**
 * 失敗したツール呼び出しの内訳 (metadata.failure)。 成功時は付かない。
 * @implements spec/feature/session-message-webui-chat.md §1.2 tool failure rendering
 */
export interface ToolFailure {
  tool: string;
  command: string;
  error: string;
}

/**
 * `失敗` の 1 語だけでは何が落ちたのか分からないので、 コマンドとエラー出力を出す
 * (neco 指示 2026-09-01)。 既定は折りたたみ — 失敗が続くセッションでログが
 * 読めなくなるのを避ける。
 * @implements spec/feature/session-message-webui-chat.md §1.2 tool failure rendering
 */
export function toolFailure(message: SessionMessage): ToolFailure | null {
  if (message.metadata?.is_error !== true) return null;
  const raw = message.metadata?.failure;
  if (typeof raw !== "object" || raw === null) return null;
  const failure = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const command = text(failure.command);
  const error = text(failure.error);
  if (!command && !error) return null;
  return { tool: text(failure.tool), command, error };
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 tool failure rendering */
function ToolFailureMessage({ message, failure }: { message: SessionMessage; failure: ToolFailure }) {
  return (
    <article className="rounded border border-danger/40 bg-danger/5 px-2 py-1.5">
      <div className="text-xs text-subtle">{message.author_label} · {fmtTs(message.ts)}</div>
      <details className="mt-1 text-sm">
        <summary className="cursor-pointer text-danger">⚠ {message.content} — 内容を見る</summary>
        {failure.command && (
          <div className="mt-2">
            <div className="text-xs text-subtle">実行した内容</div>
            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 text-xs">{failure.command}</pre>
          </div>
        )}
        {failure.error && (
          <div className="mt-2">
            <div className="text-xs text-subtle">エラー</div>
            <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 text-xs">{failure.error}</pre>
          </div>
        )}
      </details>
    </article>
  );
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 thinking rendering */
function ThinkingMessage({ message }: { message: SessionMessage }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="rounded border border-border p-2 text-xs" open={expanded} onToggle={(event) => setExpanded((event.target as HTMLDetailsElement).open)}>
      <summary>▶ 思考 …</summary>
      <pre className="mt-2 whitespace-pre-wrap font-sans">{message.content}</pre>
    </details>
  );
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 task rendering */
function TaskMessage({ message }: { message: SessionMessage }) {
  const status = taskStatus(message);
  return (
    <article className="rounded border border-accent/50 bg-accent/5 p-3">
      <div className="flex items-center gap-2 font-semibold">
        {status === "running" && <span aria-label="実行中">⏳</span>}
        <span>Task {taskStatusLabel(status)}</span>
      </div>
      <div className="mt-1 whitespace-pre-wrap">{message.content}</div>
    </article>
  );
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 delegation rendering */
function DelegationMessage({ message }: { message: SessionMessage }) {
  const metadata = message.metadata ?? {};
  const child = typeof metadata.child_session_id === "string" ? metadata.child_session_id : null;
  const parent = typeof metadata.parent_session_id === "string" ? metadata.parent_session_id : null;
  const target = child === message.session_id ? parent : child ?? parent;
  return (
    <div className="text-sm">
      {target ? (
        <Link to={`/sessions/${encodeURIComponent(target)}`} className="rounded bg-muted px-2 py-1 text-accent">
          {target === parent ? "委託元" : "委託先"}を開く →
        </Link>
      ) : message.content}
    </div>
  );
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 question rendering */
function QuestionMessage({ message, onAnswer }: {
  message: SessionMessage;
  onAnswer: (message: SessionMessage, value: number | number[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [handled, setHandled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const metadata = message.metadata ?? {};
  const answerText = typeof metadata.answer_text === "string" ? metadata.answer_text : null;
  const question = questionComponent(message);
  const isClosed = handled || metadata.answered === true || metadata.resolved === true;

  const submitAnswer = async (value: number | number[]) => {
    if (busy || isClosed) return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(message, value);
      setHandled(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded border border-warn/50 p-3">
      <div>{message.content}</div>
      {answerText !== null && <div className="mt-2 text-sm text-ok">回答: {answerText}</div>}
      {!isClosed && (
        <div className="mt-2 flex flex-wrap gap-2">
          {question.options.map((option) => question.multiSelect ? (
            <label key={option.index} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-sm">
              <input
                type="checkbox"
                checked={selected.has(option.index)}
                disabled={busy}
                onChange={() => setSelected((current) => toggleSelection(current, option.index))}
              />
              {option.label}
            </label>
          ) : (
            <button
              key={option.index}
              type="button"
              disabled={busy}
              onClick={() => void submitAnswer(option.index)}
              className="rounded border border-border px-2 py-1 text-sm disabled:opacity-50"
            >
              {option.label}
            </button>
          ))}
          {question.multiSelect && (
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => void submitAnswer(Array.from(selected).sort((left, right) => left - right))}
              className="rounded bg-accent px-2 py-1 text-sm text-white disabled:opacity-50"
            >
              選択した回答を送信
            </button>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
    </article>
  );
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 permission rendering */
function PermissionMessage({ message, onPermission }: {
  message: SessionMessage;
  onPermission: (message: SessionMessage, allow: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [handled, setHandled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (allow: boolean) => {
    if (busy || handled) return;
    setBusy(true);
    setError(null);
    try {
      await onPermission(message, allow);
      setHandled(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded border border-danger/50 p-3">
      <div>{message.content}</div>
      {!handled && (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void respond(true)} className="rounded bg-accent px-2 py-1 text-sm text-white disabled:opacity-50">許可</button>
          <button type="button" disabled={busy} onClick={() => void respond(false)} className="rounded border border-danger px-2 py-1 text-sm disabled:opacity-50">拒否</button>
        </div>
      )}
      {handled && <div className="mt-2 text-xs text-ok">回答済み</div>}
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
    </article>
  );
}

interface QuestionOption {
  index: number;
  label: string;
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 question rendering */
function questionComponent(message: SessionMessage): { options: QuestionOption[]; multiSelect: boolean } {
  const component = message.components?.find((candidate) => candidate.kind === "question_options");
  const rawOptions = Array.isArray(component?.options) ? component.options : [];
  const options = rawOptions.flatMap((candidate, fallbackIndex) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as { index?: unknown; label?: unknown };
    if (typeof item.label !== "string") return [];
    return [{
      index: typeof item.index === "number" && Number.isInteger(item.index) ? item.index : fallbackIndex,
      label: item.label,
    }];
  });
  return { options, multiSelect: component?.multi_select === true };
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 task rendering */
function taskStatus(message: SessionMessage): string {
  for (const embed of message.embeds ?? []) {
    const status = embed.fields?.find((field) => field.name === "status")?.value;
    if (status) return status;
  }
  return message.metadata?.is_error === true ? "failed" : "running";
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 task rendering */
function taskStatusLabel(status: string): string {
  if (status === "completed") return "完了";
  if (status === "failed") return "失敗";
  return "実行中";
}

/** @implements spec/feature/session-message-webui-chat.md §1.2 multi-select questions */
function toggleSelection(current: Set<number>, value: number): Set<number> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
