import { z } from "zod";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const ObservationEvent = z.object({
  id: Id,
  sequence: z.number().int().positive().max(10_000),
  kind: z.enum(["heartbeat", "progress", "preview", "question", "finished", "failed"]),
  message: z.string().max(1000).default(""),
  questionId: Id.optional(),
  previewId: Id.optional(),
}).strict().superRefine((event, ctx) => {
  if ((event.kind === "question") !== !!event.questionId)
    ctx.addIssue({ code: "custom", message: "question_id_required_only_for_question" });
  if ((event.kind === "preview") !== !!event.previewId)
    ctx.addIssue({ code: "custom", message: "preview_id_required_only_for_preview" });
  if (event.kind !== "heartbeat" && !event.message.trim())
    ctx.addIssue({ code: "custom", message: "message_required" });
});
export type ObservationEvent = z.infer<typeof ObservationEvent>;
export interface ObservationState {
  seenEventIds: readonly string[];
  seenQuestionIds: readonly string[];
  lastEvent: ObservationEvent | null;
  lastReceivedAt: number | null;
  summary: string;
  phase: "awaiting" | "working" | "waiting_answer" | "answer_ready" | "reported_finished" | "reported_failed";
  question: { id: string; text: string; answer?: { text: string; authorId: string; receivedAt: number } } | null;
}
export function initialObservation(): ObservationState {
  return { seenEventIds: [], seenQuestionIds: [], summary: "", lastEvent: null, lastReceivedAt: null, phase: "awaiting", question: null };
}

/** Server receive time is the liveness clock; remote timestamps cannot prolong it. */
export function applyObservation(state: ObservationState, input: unknown, receivedAt: number): ObservationState {
  const event = ObservationEvent.parse(input);
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0 || receivedAt < (state.lastReceivedAt ?? 0))
    throw new Error("invalid_observation_time");
  if (state.lastEvent?.id === event.id) {
    if (JSON.stringify(state.lastEvent) !== JSON.stringify(event)) throw new Error("observation_replay_conflict");
    // A replay is not new evidence of liveness.
    return state;
  }
  if (event.sequence !== (state.lastEvent?.sequence ?? 0) + 1) throw new Error("observation_sequence_conflict");
  if (state.seenEventIds.includes(event.id)) throw new Error("observation_event_reused");
  if (state.phase === "reported_finished" || state.phase === "reported_failed") throw new Error("observation_terminal");
  if (state.question && !state.question.answer && !["heartbeat", "failed"].includes(event.kind))
    throw new Error("observation_answer_required");
  let phase: ObservationState["phase"] = state.phase;
  let question = state.question;
  if (event.kind === "question") {
    if (state.seenQuestionIds.includes(event.questionId!)) throw new Error("observation_question_reused");
    question = { id: event.questionId!, text: event.message };
    phase = "waiting_answer";
  } else if (event.kind === "finished") phase = "reported_finished";
  else if (event.kind === "failed") phase = "reported_failed";
  else if (phase !== "waiting_answer" && !(phase === "answer_ready" && event.kind === "heartbeat")) phase = "working";
  return { lastEvent: event, lastReceivedAt: receivedAt, phase, question,
    summary: event.kind === "heartbeat" ? state.summary : event.message,
    seenEventIds: [...state.seenEventIds, event.id],
    seenQuestionIds: event.questionId ? [...state.seenQuestionIds, event.questionId] : state.seenQuestionIds };
}

/** Authorization belongs to the caller; this policy binds an answer to one pending question. */
export function answerObservation(state: ObservationState, questionId: string, text: string,
  authorId: string, receivedAt: number): ObservationState {
  if (state.phase !== "waiting_answer" || !state.question || state.question.id !== questionId)
    throw new Error("observation_question_not_pending");
  if (!text.trim() || text.length > 1000 || !/^\d{1,25}$/.test(authorId)
    || !Number.isSafeInteger(receivedAt) || receivedAt < (state.lastReceivedAt ?? 0))
    throw new Error("invalid_observation_answer");
  return { ...state, phase: "answer_ready", question: { ...state.question, answer: { text, authorId, receivedAt } } };
}

export function observationLiveness(state: ObservationState, now: number): "unobserved" | "recent" | "disconnected" {
  if (state.lastReceivedAt === null) return "unobserved";
  return now >= state.lastReceivedAt && now - state.lastReceivedAt < 180_000 ? "recent" : "disconnected";
}
