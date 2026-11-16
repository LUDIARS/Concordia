/**
 * 自動確認 (stalled-session-nudge) が送るのを見送った理由の記録。
 * debug ログだけでは不可視だったので、info ログに session_id と理由を出し、
 * セッション metadata に最後の 1 件を上書きで残す (管制ボードが last_skip_reason として読む)。
 *
 * @implements spec/feature/control-session.md §2
 */
import type { SessionsRepo } from "../db/sessions-repo.js";

export const NUDGE_SKIP_METADATA_KEY = "stall_nudge_skip";

export type NudgeSkipReason =
  | "pending_question_or_human_wait"
  | "awaiting_human_input_ask"
  | "previous_nudge_unanswered"
  | "struck_out"
  | "session_changed"
  | "awaiting_human_response"
  | "undeliverable"
  | "delivery_claim_lost";

export const NUDGE_SKIP_LABEL: Record<NudgeSkipReason, string> = {
  pending_question_or_human_wait: "質問カードの回答待ち・human-wait (または照会できない)",
  awaiting_human_input_ask: "ask で人間の入力待ち",
  previous_nudge_unanswered: "前回の自動確認が未返信",
  struck_out: "自動確認の 3 アウト",
  session_changed: "確認中にセッションの担当が変わった",
  awaiting_human_response: "人間の応答待ちの確認",
  undeliverable: "届け先が未接続",
  delivery_claim_lost: "別経路が先に確認を送った",
};

export interface NudgeSkipRecord {
  reason: NudgeSkipReason;
  at: number;
}

export function recordNudgeSkip(
  repo: Pick<SessionsRepo, "updateMetadata">,
  log: { info(obj: Record<string, unknown>, message: string): void },
  sessionId: string,
  reason: NudgeSkipReason,
  nowMs: number,
): void {
  log.info({ session_id: sessionId, reason }, "stall nudge skipped");
  try {
    repo.updateMetadata(sessionId, (metadata) => ({
      ...metadata,
      [NUDGE_SKIP_METADATA_KEY]: { reason, at: Math.floor(nowMs / 1000) } satisfies NudgeSkipRecord,
    }));
  } catch {
    // 記録の失敗で巡回を止めない (ログは出している)。
  }
}

export function readNudgeSkip(metadata: string | null): NudgeSkipRecord | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[NUDGE_SKIP_METADATA_KEY] as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object") return null;
    const reason = value.reason;
    if (typeof reason !== "string" || !(reason in NUDGE_SKIP_LABEL) || typeof value.at !== "number") return null;
    return { reason: reason as NudgeSkipReason, at: value.at };
  } catch {
    return null;
  }
}

/** ボードに載せる一行 (理由と時刻)。 */
export function describeNudgeSkip(record: NudgeSkipRecord | null): string | null {
  return record ? `${NUDGE_SKIP_LABEL[record.reason]} (at ${record.at})` : null;
}
