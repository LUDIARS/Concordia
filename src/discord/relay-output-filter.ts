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

/** 指示 1 回ごとの最後の発言 (最終回答・会話の要約)。 */
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

/**
 * セッションが chat 経路 (lictor chat・圧縮の通知・終了の独白など) で出す投稿を流すか。
 * FINAL ANSWER は session.message で届くので、 chat 経路の投稿はすべて途中の発言として扱う。
 * #報告 などのメタチャンネル宛ても止める (非公開の相談の中身がそこへ漏れないように)。
 */
export function shouldRelaySessionChatPost(policy: RelayOutputPolicy): boolean {
  return policy.intermediate;
}
