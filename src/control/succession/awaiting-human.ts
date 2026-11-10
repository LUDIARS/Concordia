/**
 * セッションが人間の返事を待っているかの判定 (自動引き継ぎの awaiting_human)。
 *
 * 待ちの signal は複数系統あり、 1 つでも立っていれば待ち中とみなす。 stalled-session-nudge と
 * 同じ集合を見る — 片方だけを見ると、 カードを出さない ask マーカー (Lictor relay の ```ask フェンス)
 * で返事を待つセッションを畳んでしまい、 人間の回答が閉じたセッションへ届く。
 *
 *   1. Cc の未回答質問カード (discord_pending_questions)
 *   2. human-wait の記録 (session metadata)
 *   3. 人間の確認待ち (human_response_confirmation)
 *   4. transcript 末尾の ask マーカー
 *
 * 安い metadata 系を先に見て、 transcript 末尾の読み取りは最後にする。
 *
 * @implements spec/feature/session-auto-succession.md §2.1 (awaiting_human, INV-3)
 */

import type { SessionRow } from "../../shared/types.js";

export interface AwaitingHumanPorts {
  hasUnansweredQuestion(sessionId: string): boolean;
  isHumanWaitActive(sessionId: string): boolean;
  isWaitingForHumanResponse(sessionId: string): boolean;
  /** transcript 末尾。 読めなければ null。 */
  readTranscriptTail(session: SessionRow): Promise<string | null>;
  /** 末尾の最後の assistant 発言が ask マーカーで、 その後に user 発言が無いか。 */
  isAskMarkerPending(tail: string | null): boolean;
}

export async function isSessionAwaitingHuman(ports: AwaitingHumanPorts, session: SessionRow): Promise<boolean> {
  if (ports.hasUnansweredQuestion(session.id)) return true;
  if (ports.isHumanWaitActive(session.id)) return true;
  if (ports.isWaitingForHumanResponse(session.id)) return true;
  return ports.isAskMarkerPending(await ports.readTranscriptTail(session));
}
