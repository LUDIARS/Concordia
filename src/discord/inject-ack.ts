/**
 * Discord inject → ✅ リアクションの「保留」トラッカー。
 * 方針と契約は platform/inject-ack-tracker.ts。 Discord 用の 1 インスタンスを公開する。
 */
import { createInjectAckTracker, type PendingInjectAck } from "../platform/inject-ack-tracker.js";

export type { PendingInjectAck };

const tracker = createInjectAckTracker();

/** inject 成功時に「transcript が動いたら ✅ を付ける対象」を登録する。 */
export function recordInjectAck(sessionId: string, channelId: string, messageId: string, now = Date.now()): void {
  tracker.record(sessionId, channelId, messageId, now);
}

/** 保留中の ✅ 対象を取り出して消す (無ければ null)。 */
export function takeInjectAck(sessionId: string): PendingInjectAck | null {
  return tracker.take(sessionId);
}

/** テスト用: 全クリア。 */
export function clearInjectAcks(): void {
  tracker.clear();
}
