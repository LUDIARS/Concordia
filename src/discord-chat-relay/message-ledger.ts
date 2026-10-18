/**
 * 同じ messageId を 1 回だけ転送するための記録 (spec/feature/discord-chat-relay.md DCR-INV-03)。
 *
 * ゲートウェイの再接続で同じ messageCreate が届いても転送しない。 転送の前に記録するので、
 * 結果不明 (タイムアウト) の発言も再送しない。 プロセス内の記録で、 古いものから捨てる。
 *
 * @implements spec/feature/discord-chat-relay.md — 値と不変条件
 */

export const DEFAULT_MESSAGE_LEDGER_CAPACITY = 5_000;

export interface MessageLedger {
  /** 初めての messageId なら記録して true、 既に記録済みなら false。 */
  claim(messageId: string): boolean;
}

export function createMessageLedger(capacity = DEFAULT_MESSAGE_LEDGER_CAPACITY): MessageLedger {
  // Set は挿入順を保つので、 先頭が最も古い。
  const seen = new Set<string>();
  return {
    claim(messageId) {
      if (seen.has(messageId)) return false;
      seen.add(messageId);
      if (seen.size > capacity) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
  };
}
