/**
 * 管制からの指示 (一括指示・追加指示) を送ってよいセッションかの判定。
 * 人間の判断待ちと部署の自動確認 OFF は送らない。照会できないときも送らない。
 *
 * @implements spec/feature/control-session.md — 5. 指示の送り方 / CC-CTL-INV-05
 */
import type { SessionRow } from "../shared/types.js";

export type IneligibleReason =
  | "not_active"
  | "control_session"
  | "auto_check_off"
  | "pending_question"
  | "human_wait"
  | "awaiting_human_response"
  | "ask_marker"
  | "state_unavailable";

export interface EligibilityProbes {
  isControlSession(sessionId: string): boolean;
  isAutoCheckDisabled(session: SessionRow): boolean;
  hasPendingQuestion(sessionId: string): boolean;
  isHumanWaitActive(sessionId: string): boolean;
  isWaitingForHumanResponse(sessionId: string): boolean;
  /** transcript 末尾が ask マーカーで人間の入力を待っているか。読めなければ null。 */
  isAwaitingAsk(session: SessionRow): Promise<boolean | null>;
}

export type Eligibility = { ok: true } | { ok: false; reason: IneligibleReason };

export async function checkInstructionEligibility(
  session: SessionRow | null, probes: EligibilityProbes,
): Promise<Eligibility> {
  if (!session || session.status !== "active") return { ok: false, reason: "not_active" };
  try {
    if (probes.isControlSession(session.id)) return { ok: false, reason: "control_session" };
    if (probes.isAutoCheckDisabled(session)) return { ok: false, reason: "auto_check_off" };
    if (probes.hasPendingQuestion(session.id)) return { ok: false, reason: "pending_question" };
    if (probes.isHumanWaitActive(session.id)) return { ok: false, reason: "human_wait" };
    if (probes.isWaitingForHumanResponse(session.id)) return { ok: false, reason: "awaiting_human_response" };
    const ask = await probes.isAwaitingAsk(session);
    if (ask === null) return { ok: false, reason: "state_unavailable" };
    if (ask) return { ok: false, reason: "ask_marker" };
  } catch {
    // 待ちの状態を確かめられない間は送らない (人間の判断停止を踏み潰さない)。
    return { ok: false, reason: "state_unavailable" };
  }
  return { ok: true };
}

/** 返信や API 応答に出す理由の日本語。 */
export const INELIGIBLE_REASON_LABEL: Record<IneligibleReason, string> = {
  not_active: "動いていない",
  control_session: "管制セッション自身",
  auto_check_off: "部署の自動確認 OFF",
  pending_question: "質問カードの回答待ち",
  human_wait: "人間待ち (human-wait)",
  awaiting_human_response: "人間の応答待ちの確認",
  ask_marker: "ask で人間の入力待ち",
  state_unavailable: "待ちの状態を確認できない",
};
