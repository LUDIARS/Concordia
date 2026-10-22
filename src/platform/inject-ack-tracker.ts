/**
 * 指示 (inject) → ✅ リアクションの「保留」トラッカー (platform 非依存)。
 *
 * 方針: 指示 (inject) を受けただけでは ✅ を付けず、 **transcript が動いた
 * (= セッションが実際にその指示を読み込んで処理を始めた)** タイミングで初めて
 * 付ける。 こうすると、 Enter が送られず指示が宙に浮いたケースでは transcript が
 * 動かないので ✅ が付かず、 「届いたが実行されていない」を見分けられる。
 *
 * - ingress が inject 成功時に `record` で (channel, message) を登録。
 * - bot 側の session.message / prompt イベントハンドラが `take` で取り出し、
 *   ✅ を 1 回だけ付ける (delete-on-read なので二重リアクションしない)。
 * - 1 セッション 1 件のみ保持 (新しい inject は上書き)。 Enter 未送信で動かない
 *   ケースのエントリは次の inject まで残るだけで、 メモリ影響は無視できる。
 * - プラットフォームごとに別インスタンスを持つ (Discord の保留を Slack が取らない)。
 */

export interface PendingInjectAck {
  channelId: string;
  messageId: string;
  at: number;
}

export interface InjectAckTracker {
  /** inject 成功時に「transcript が動いたら ✅ を付ける対象」を登録する。 */
  record(sessionId: string, channelId: string, messageId: string, now?: number): void;
  /** 保留中の ✅ 対象を取り出して消す (無ければ null)。 */
  take(sessionId: string): PendingInjectAck | null;
  /** 全クリア (テスト・停止用)。 */
  clear(): void;
}

export function createInjectAckTracker(): InjectAckTracker {
  const pending = new Map<string, PendingInjectAck>();
  return {
    record(sessionId, channelId, messageId, now = Date.now()) {
      pending.set(sessionId, { channelId, messageId, at: now });
    },
    take(sessionId) {
      const e = pending.get(sessionId);
      if (!e) return null;
      pending.delete(sessionId);
      return e;
    },
    clear() {
      pending.clear();
    },
  };
}
