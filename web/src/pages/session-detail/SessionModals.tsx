import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtTs, statusBadge } from "../../api.js";
import type { SessionEvent, SessionRow } from "../../api.js";
import { useLiveQuery, useWsEvent } from "../../hooks/useWsEvent.js";
import { projectCodeFor, repoBasename } from "../../project-codes.js";

// ─── permission modal ────────────────────────────────────────────────

interface PendingPermission {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
}

export function PermissionModal({ sessionId }: { sessionId: string }) {
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

function mergeQuestions(existing: PendingQuestionUi[], incoming: PendingQuestionUi[]): PendingQuestionUi[] {
  const byId = new Map<number, PendingQuestionUi>();
  for (const q of existing) byId.set(q.question_id, q);
  for (const q of incoming) byId.set(q.question_id, q);
  return Array.from(byId.values()).sort((a, b) => (a.ts - b.ts) || (a.question_id - b.question_id));
}

const QUESTION_DISPLAY_DELAY_MS = 350;

export function AskUserQuestionModal({ sessionId, events }: { sessionId: string; events: SessionEvent[] }) {
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
