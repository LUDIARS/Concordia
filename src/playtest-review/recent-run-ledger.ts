/**
 * AI プレイテスト感想の二重投稿を止める台帳 (CC-PLAYTEST-INV-02)。 同じ runId を受けたら 2 回目以降は配送しない。
 *
 * DB には持たない (このプロセスが受けた直近の runId だけ)。 Ingenium は 1 回の run で 1 度だけ
 * 送り、送り直すのは応答を受け取れなかったときだけなので、再起動を跨ぐ重複までは防がない。
 * 上限を超えたら古い順に忘れる。
 *
 * @implements spec/feature/playtest-review-notify.md — 二重投稿の抑止
 */

export interface PlaytestReviewLedger {
  /** 初めての runId なら true を返して記録する。 既に受けた runId なら false。 */
  claim(runId: string): boolean;
}

export const RECENT_RUN_LIMIT = 1000;

export function createRecentRunLedger(limit = RECENT_RUN_LIMIT): PlaytestReviewLedger {
  const seen = new Set<string>();
  return {
    claim(runId) {
      if (seen.has(runId)) return false;
      seen.add(runId);
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
  };
}
