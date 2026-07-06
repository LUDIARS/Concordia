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
