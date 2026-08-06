import type { SessionEventRow } from "../shared/types.js";

const DEFAULT_MAX_EVENTS = 60;
const DEFAULT_MAX_COMPLETED_QUESTIONS = 60;

const SUMMARY_EVENT_KINDS = new Set([
  "prompt",
  "edit",
  "tool_call",
  "task_update",
  "inject",
  "lost",
  "pending_question",
]);

const QUESTION_COMPLETION_EVENT_KINDS = new Set([
  "question_answered",
  "question_resolved",
]);

export interface SummaryEventExcerpt {
  kind: string;
  ago_sec: number;
  payload: unknown;
}

export interface SummaryQuestionStateReader {
  findById(id: number): {
    session_id: string;
    answered_at: number | null;
  } | null;
}

export interface BuildSummaryEventExcerptOptions {
  referenceTimeSeconds?: number;
  /** 通常イベントの上限。完了質問は別枠。 */
  maxEvents?: number;
  maxCompletedQuestions?: number;
  /**
   * `discord_pending_questions` など、質問状態の正本。
   * 回答行更新後・completion event 追加前に異常終了した場合も回答済みを復元する。
   */
  questionState?: SummaryQuestionStateReader;
}

interface CompletionEvidence {
  questionId: string;
  sessionId: string;
  completedAt: number;
  status: "answered" | "resolved" | "completed";
  source: "event" | "question_state";
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function safeParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function readQuestionId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).question_id;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return String(raw);
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isSafeInteger(numeric)) return String(numeric);
  }
  return trimmed;
}

function databaseQuestionId(questionId: string): number | null {
  if (!/^\d+$/.test(questionId)) return null;
  const numeric = Number(questionId);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function stableEventOrder(a: SessionEventRow, b: SessionEventRow): number {
  return a.ts - b.ts || a.id - b.id;
}

/**
 * Sonnet に渡すイベントを、質問の現在状態と突き合わせて決定的に絞り込む。
 *
 * 回答済み pending_question 自体は候補から外す一方、末尾に
 * question_completed を合成する。古い prompt/inject に「未回答」と残っていても、
 * classifier が後続の完了証跡を優先できるようにするため。
 */
export function buildSummaryEventExcerpt(
  events: SessionEventRow[],
  opts: BuildSummaryEventExcerptOptions = {},
): SummaryEventExcerpt[] {
  const referenceTimeSeconds = opts.referenceTimeSeconds ?? nowSec();
  const maxEvents = Math.max(0, Math.floor(opts.maxEvents ?? DEFAULT_MAX_EVENTS));
  const maxCompletedQuestions = Math.max(
    0,
    Math.floor(opts.maxCompletedQuestions ?? DEFAULT_MAX_COMPLETED_QUESTIONS),
  );
  if (maxEvents === 0 && maxCompletedQuestions === 0) return [];

  const pendingPayloads = new Map<number, unknown>();
  const pendingQuestionIds = new Set<string>();
  const pendingSessionIds = new Map<string, Set<string>>();
  const completions = new Map<string, CompletionEvidence>();
  const orderedEvents = [...events].sort(stableEventOrder);

  // 全 payload を先に parse しない。状態照合に必要な質問イベントだけを先読みする。
  for (const event of orderedEvents) {
    if (event.kind === "pending_question") {
      const payload = safeParse(event.payload);
      pendingPayloads.set(event.id, payload);
      const questionId = readQuestionId(payload);
      if (questionId !== null) {
        pendingQuestionIds.add(questionId);
        const sessionIds = pendingSessionIds.get(questionId) ?? new Set<string>();
        sessionIds.add(event.session_id);
        pendingSessionIds.set(questionId, sessionIds);
      }
      continue;
    }
    if (!QUESTION_COMPLETION_EVENT_KINDS.has(event.kind)) continue;
    const payload = safeParse(event.payload);
    const questionId = readQuestionId(payload);
    if (questionId === null) continue;
    completions.set(questionId, {
      questionId,
      sessionId: event.session_id,
      completedAt: event.ts,
      status: event.kind === "question_answered" ? "answered" : "resolved",
      source: "event",
    });
  }

  // reader がある経路では durable row を唯一の正本とし、event は状態決定に使わない。
  // durable row 更新後・completion event 追加前の異常終了もここで補完できる。
  if (opts.questionState) {
    for (const questionId of pendingQuestionIds) {
      const numericId = databaseQuestionId(questionId);
      if (numericId === null) {
        completions.delete(questionId);
        continue;
      }
      const row = opts.questionState.findById(numericId);
      const sessionIds = pendingSessionIds.get(questionId);
      const ownsQuestion = row !== null
        && sessionIds?.size === 1
        && sessionIds.has(row.session_id);
      if (!ownsQuestion || row.answered_at === null) {
        completions.delete(questionId);
        continue;
      }
      completions.set(questionId, {
        questionId,
        sessionId: row.session_id,
        completedAt: row.answered_at,
        status: "completed",
        source: "question_state",
      });
    }
  }

  const relevantCompletedIds = new Set<string>();
  const candidates = orderedEvents
    .filter((event) => SUMMARY_EVENT_KINDS.has(event.kind))
    .filter((event) => {
      if (event.kind !== "pending_question") return true;
      const questionId = readQuestionId(pendingPayloads.get(event.id));
      if (questionId === null) return true;
      const completion = completions.get(questionId);
      if (!completion || completion.sessionId !== event.session_id) return true;
      relevantCompletedIds.add(questionId);
      return false;
    });

  const markerCandidates = [...relevantCompletedIds]
    .map((questionId) => completions.get(questionId)!)
    .sort((a, b) => a.completedAt - b.completedAt || a.questionId.localeCompare(b.questionId))
    .map((completion): SummaryEventExcerpt => {
      const payload: Record<string, unknown> = {
        question_id: completion.questionId,
        status: completion.status,
        source: completion.source,
      };
      return {
        kind: "question_completed",
        ago_sec: referenceTimeSeconds - completion.completedAt,
        payload,
      };
    });
  const markers = maxCompletedQuestions > 0
    ? markerCandidates.slice(-maxCompletedQuestions)
    : [];

  const selectedCandidates = maxEvents > 0 ? candidates.slice(-maxEvents) : [];
  const ordinary = selectedCandidates.map((event): SummaryEventExcerpt => ({
    kind: event.kind,
    ago_sec: referenceTimeSeconds - event.ts,
    payload: event.kind === "pending_question"
      ? pendingPayloads.get(event.id)
      : safeParse(event.payload),
  }));

  return [...ordinary, ...markers];
}
