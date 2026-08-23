/**
 * エラー報告の中央ヘルパ.
 *
 * 監視ロガーの検知 / Concordia 内部 (Discord 操作等) の失敗を `error.reported`
 * イベントとして 1 本に集約する. イベントは本社ランタイムのログ・WebSocket・
 * 自動修正パイプラインで扱い、Discord チャンネルへは転記しない.
 */

import { eventBus } from "./events.js";

export function reportError(
  source: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  eventBus.emit({
    type: "error.reported",
    source,
    message: message.slice(0, 1500),
    detail,
    ts: Math.floor(Date.now() / 1000),
  });
}

/** ログ文字列が「失敗」 を表すか (warn の中から失敗だけ拾うための簡易判定). */
export function looksLikeFailure(message: string): boolean {
  return /fail|error|✗|exception|reject/i.test(message);
}
