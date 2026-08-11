import type { SessionsRepo } from "../db/sessions-repo.js";

export const END_SESSION_REQUESTED_AT_KEY = "session_end_requested_at";

const JAPANESE_END_SESSION_REQUEST =
  /^(?:では|じゃあ|それでは)?(?:この)?セッション(?:を)?(?:終了|しゅうりょう)(?:処理)?(?:して|してください|して下さい|します|しよう|で|お願い(?:します)?)?[。.!！]*$/;
const COMMAND_END_SESSION_REQUEST =
  /^(?:では|じゃあ|それでは)?[/$]?session[-_]?end(?:して|してください|して下さい|します|しよう|で|お願い(?:します)?)?[。.!！]*$/i;

export function detectsEndSessionRequest(text: string): boolean {
  const normalized = text.replace(/[\s　]+/g, "");
  if (!normalized) return false;
  if (/(しないで|しない|せず|不要|やめて|中止|禁止)/.test(normalized)) return false;

  // 終了は破壊的なので、単なる言及 (例:「session-end skill をレビュー」) ではなく
  // 発話全体が終了指示として読める形だけを受ける。
  return JAPANESE_END_SESSION_REQUEST.test(normalized) || COMMAND_END_SESSION_REQUEST.test(normalized);
}

export function readEndSessionRequestedAt(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as Record<string, unknown>)[END_SESSION_REQUESTED_AT_KEY];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function markEndSessionRequested(
  sessions: Pick<SessionsRepo, "mergeMetadata">,
  sessionId: string,
  nowSec = Math.floor(Date.now() / 1000),
): void {
  sessions.mergeMetadata(sessionId, { [END_SESSION_REQUESTED_AT_KEY]: nowSec });
}
