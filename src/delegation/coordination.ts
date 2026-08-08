import type { DelegationRunRow } from "../db/delegation-repo.js";

export type DelegationStatus = "running" | "completed" | "failed";

export interface DelegationStatusPayload {
  status: DelegationStatus;
  detail?: string;
  result?: string;
}

export function normalizeDelegationStatus(value: unknown): DelegationStatus | null {
  return value === "running" || value === "completed" || value === "failed" ? value : null;
}

export function resolveDelegationRunIdForSession(input: {
  metadataRunId?: unknown;
  pendingRunId?: string | null;
}): string | null {
  if (typeof input.metadataRunId === "string" && input.metadataRunId.trim()) {
    return input.metadataRunId.trim();
  }
  return input.pendingRunId?.trim() || null;
}

export function buildDelegationStatusNotification(
  run: Pick<DelegationRunRow, "id" | "call_name" | "child_session_id">,
  payload: DelegationStatusPayload,
): string {
  const title = payload.status === "completed"
    ? "Delegation completed"
    : payload.status === "failed"
      ? "Delegation failed"
      : "Delegation running";
  const lines = [
    `${title}: ${run.call_name}`,
    `run_id: ${run.id}`,
  ];
  if (run.child_session_id) lines.push(`child_session_id: ${run.child_session_id}`);
  if (payload.detail?.trim()) lines.push(`detail: ${payload.detail.trim()}`);
  if (payload.result?.trim()) lines.push(`result: ${payload.result.trim()}`);
  return lines.join("\n");
}

export function buildDelegationInjectText(input: {
  runId: string;
  text: string;
}): string {
  return [
    `[delegation:${input.runId}] Parent instruction`,
    "",
    input.text.trim(),
  ].join("\n");
}

/**
 * 委託子セッションの Question を親 (委託元) セッションへリレーする本文。
 * 親は自分で判断して answer-question API で回答するか、 人間へ ask で引き継ぐ。
 */
export function buildDelegationQuestionRelayText(input: {
  runId: string;
  childSessionId: string;
  questionId: number;
  question: string;
  options: readonly string[];
}): string {
  return [
    `[delegation:${input.runId}] 子セッション ${input.childSessionId} からの質問`,
    "",
    input.question.trim(),
    "",
    ...input.options.map((label, i) => `${i}. ${label}`),
    "",
    "委託元として回答してください:",
    `POST /v1/sessions/${input.childSessionId}/answer-question`,
    `body: {"question_id":${input.questionId},"answer_index":<番号>} または {"question_id":${input.questionId},"other_text":"..."}`,
    "自分で判断できない場合は ask マーカーで人間へ引き継いでください。",
  ].join("\n");
}

export function buildDelegationMirrorText(input: {
  runId: string;
  childSessionId: string;
  text: string;
}): string {
  return [
    `[delegation:${input.runId}] child ${input.childSessionId}`,
    "",
    input.text.trim(),
  ].join("\n");
}
