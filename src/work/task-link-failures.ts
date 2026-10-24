/**
 * @implements CC-TASK-LINKED-FOLLOWUP — 関連付けできなかった Actio タスク参照の記録。
 *
 * 関連付けが範囲外・未存在で拒否されると、セッションには task link が無いまま残り、自動確認は
 * 状態 unknown を理由なしで繰り返していた (2026-10-23 不具合 162bc3a6)。拒否した参照と理由を
 * セッション metadata に残し、自動確認がその理由を示せるようにする。状態の正本は Actio のまま。
 */
import type { SessionsRepo } from "../db/sessions-repo.js";

export const SESSION_TASK_LINK_FAILURES_KEY = "cc_task_link_failures";
/** 最近のものだけ残す。理由を示すためだけの記録で、履歴ではない。 */
const MAX_FAILURES = 4;

export interface TaskLinkFailure {
  task_reference: string;
  /** Actio の一時的な不通は記録しない (次の関連付けで再試行する)。 */
  reason: "task_out_of_scope" | "not_found";
  at: number;
}

function isFailure(value: unknown): value is TaskLinkFailure {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.task_reference === "string" && Number.isFinite(item.at)
    && (item.reason === "task_out_of_scope" || item.reason === "not_found");
}

export function readTaskLinkFailures(metadata: string | null): TaskLinkFailure[] {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[SESSION_TASK_LINK_FAILURES_KEY];
    return Array.isArray(value) ? value.filter(isFailure).slice(-MAX_FAILURES) : [];
  } catch { return []; }
}

function failuresOf(metadata: Record<string, unknown>): TaskLinkFailure[] {
  const value = metadata[SESSION_TASK_LINK_FAILURES_KEY];
  return Array.isArray(value) ? value.filter(isFailure) : [];
}

/** 同じ参照の記録は最新の理由で置き換える。 */
export function recordTaskLinkFailure(
  sessions: Pick<SessionsRepo, "updateMetadata">, sessionId: string, failure: TaskLinkFailure,
): void {
  sessions.updateMetadata(sessionId, (metadata) => ({
    ...metadata,
    [SESSION_TASK_LINK_FAILURES_KEY]: [
      ...failuresOf(metadata).filter((item) => item.task_reference !== failure.task_reference), failure,
    ].slice(-MAX_FAILURES),
  }));
}

/** 関連付けに成功した参照の記録を消した metadata を返す (updateMetadata の中で使う)。 */
export function clearTaskLinkFailure(metadata: Record<string, unknown>, taskReference: string): Record<string, unknown> {
  if (!(SESSION_TASK_LINK_FAILURES_KEY in metadata)) return metadata;
  const rest = failuresOf(metadata).filter((item) => item.task_reference !== taskReference);
  if (rest.length) return { ...metadata, [SESSION_TASK_LINK_FAILURES_KEY]: rest };
  const others = { ...metadata };
  delete others[SESSION_TASK_LINK_FAILURES_KEY];
  return others;
}
