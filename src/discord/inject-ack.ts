/**
 * Discord inject → ✅ リアクションの「保留」トラッカー。
 *
 * 方針: 指示 (inject) を受けただけでは ✅ を付けず、 **transcript が動いた
 * (= セッションが実際にその指示を読み込んで処理を始めた)** タイミングで初めて
 * 付ける。 こうすると、 Enter が送られず指示が宙に浮いたケースでは transcript が
 * 動かないので ✅ が付かず、 「届いたが実行されていない」を見分けられる。
 *
 * - ingress が inject 成功時に `recordInjectAck` で (channel, message) を登録。
 * - bot 側の transcript.frame / prompt イベントハンドラが `takeInjectAck` で取り出し、
 *   ✅ を 1 回だけ付ける (delete-on-read なので二重リアクションしない)。
 * - 1 セッション 1 件のみ保持 (新しい inject は上書き)。 Enter 未送信で動かない
 *   ケースのエントリは次の inject まで残るだけで、 メモリ影響は無視できる。
 */

export interface PendingInjectAck {
  channelId: string;
  messageId: string;
  at: number;
}

const pending = new Map<string, PendingInjectAck>();

/** inject 成功時に「transcript が動いたら ✅ を付ける対象」を登録する。 */
export function recordInjectAck(sessionId: string, channelId: string, messageId: string, now = Date.now()): void {
  pending.set(sessionId, { channelId, messageId, at: now });
}

/** 保留中の ✅ 対象を取り出して消す (無ければ null)。 */
export function takeInjectAck(sessionId: string): PendingInjectAck | null {
  const e = pending.get(sessionId);
  if (!e) return null;
  pending.delete(sessionId);
  return e;
}

/** テスト用: 全クリア。 */
export function clearInjectAcks(): void {
  pending.clear();
}
