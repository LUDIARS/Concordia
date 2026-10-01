/**
 * 部署の出力方針で、 セッションの発言を Discord へ流すかを決める純関数 (spec/feature/departments.md §9.4)。
 *
 * 2026-10-02 neco 指示 (技術相談課): フォーラム / チャンネルに出すのは「FINAL ANSWER のみ」で、
 * Cc の Inject 指令は出さない。 前提質問と状態カードは残す (それぞれ別の経路で投稿される)。
 *
 * - `intermediate` が切られていれば、 指示 1 回ごとの最後の発言 (最終回答・会話の要約) 以外を落とす。
 * - `inject_transcript` が切られていれば、 Cc が送った指令の転記 (task / delegation / system) を落とす。
 *
 * @implements SPEC-DEPT-OUTPUT
 */

import type { SessionMessageAuthorType } from "../shared/session-message-types.js";

export interface RelayableMessage {
  author_type: SessionMessageAuthorType;
  metadata?: { phase?: unknown } | null;
}

export interface RelayOutputPolicy {
  /** 途中の発言を出すか。 */
  intermediate: boolean;
  /** Cc の指令の転記を出すか。 */
  injectTranscript: boolean;
}

/** Cc が組み立ててセッションへ送った指令の転記。 */
const INJECT_TRANSCRIPT_TYPES: ReadonlySet<SessionMessageAuthorType> = new Set(["task", "delegation", "system"]);

/** 指示 1 回ごとの最後の発言 (Discord で FINAL ANSWER として飾るもの)。 */
export function isFinalAnswerMessage(message: RelayableMessage): boolean {
  return message.author_type === "summary"
    || (message.author_type === "assistant" && message.metadata?.phase === "final_answer");
}

export function isInjectTranscriptMessage(message: RelayableMessage): boolean {
  return INJECT_TRANSCRIPT_TYPES.has(message.author_type);
}

export function shouldRelaySessionMessage(message: RelayableMessage, policy: RelayOutputPolicy): boolean {
  if (!policy.injectTranscript && isInjectTranscriptMessage(message)) return false;
  if (!policy.intermediate && !isFinalAnswerMessage(message)) return false;
  return true;
}
