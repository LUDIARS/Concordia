/**
 * @implements spec/feature/phase-compaction.md §2 (参照層)
 *
 * フェーズ文脈の message-id 索引層 — カード投稿時に Discord message id を
 * セッション metadata へ記録する。`buildPhaseContext` (control/phase-compaction.ts)
 * が探索なしで索引を組めるよう、投稿箇所 (plan card / question card) から呼ぶ。
 */
import type { SessionsRepo } from "../db/sessions-repo.js";

type MetadataSessions = Pick<SessionsRepo, "mergeMetadata">;
type PhaseIndexLog = { warn: (message: string) => void };

function recordCardMessageId(
  sessions: MetadataSessions,
  sessionId: string,
  metadataKey: "discord_plan_message_id" | "discord_question_message_id",
  messageId: string | null | undefined,
  log: PhaseIndexLog,
): void {
  if (!messageId) return;
  try {
    sessions.mergeMetadata(sessionId, { [metadataKey]: messageId });
  } catch (error) {
    // カード投稿は既に成功している。補助索引の失敗で投稿済み処理を reject させない。
    log.warn(`phase-index: metadata record failed session=${sessionId} key=${metadataKey}: ${(error as Error).message}`);
  }
}

/** プランカード投稿後に message id を best-effort で記録する。 */
export function recordPlanCardMessageId(
  sessions: MetadataSessions,
  sessionId: string,
  messageId: string | null | undefined,
  log: PhaseIndexLog,
): void {
  recordCardMessageId(sessions, sessionId, "discord_plan_message_id", messageId, log);
}

/** 設問カード (契約カード含む) 投稿後に message id を best-effort で記録する。 */
export function recordQuestionCardMessageId(
  sessions: MetadataSessions,
  sessionId: string,
  messageId: string | null | undefined,
  log: PhaseIndexLog,
): void {
  recordCardMessageId(sessions, sessionId, "discord_question_message_id", messageId, log);
}
