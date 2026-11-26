/**
 * Hub の制限値と、 その判定に使う小さな数え上げ (契約 v1 §2 制限)。
 *
 * - 1 フレーム 64 KiB (protocol.ts の MAX_FRAME_BYTES)
 * - 1 トークン同時接続 2
 * - 1 接続 毎分 60 要求
 * - 投稿は 1 ユーザー毎分 10 件
 * - 海外接続の通知は 同一トークン・同一国で 1 時間に 1 回
 * - カリオペの再生成は 同一プロジェクトで 1 時間に 1 回
 *
 * 時刻は呼び出し側から渡す (テストが時計を進められるように)。 状態はメモリだけで、
 * プロセスが落ちれば数え直しになる (上限は乱用を止めるためのもので、 課金の台帳ではない)。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-LIMIT)
 */

export const HUB_LIMITS = {
  concurrentConnectionsPerToken: 2,
  requestsPerConnectionPerMinute: 60,
  postsPerUserPerMinute: 10,
  overseasNoticeWindowMs: 60 * 60 * 1000,
  calliopeRefreshWindowMs: 60 * 60 * 1000,
  authFrameTimeoutMs: 5_000,
} as const;

const MINUTE_MS = 60_000;

/** キーごとの直近 window 内の件数で判定する (固定窓ではなく滑り窓)。 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number = MINUTE_MS) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  }

  /** 1 件数えてよければ数えて true。 上限なら数えずに false。 */
  tryHit(key: string, nowMs: number): boolean {
    const since = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

/** キーごとに window 内 1 回だけ通す (通知の間引き・再生成の間隔)。 */
export class KeyedThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** 通してよければ記録して true。 */
  tryPass(key: string, nowMs: number): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && nowMs - previous < this.windowMs) return false;
    this.last.set(key, nowMs);
    return true;
  }

  /** 次に通れる時刻 (ms)。 通れるなら nowMs。 */
  nextAllowedAt(key: string, nowMs: number): number {
    const previous = this.last.get(key);
    if (previous === undefined) return nowMs;
    return Math.max(nowMs, previous + this.windowMs);
  }

  /** 永続化された直近時刻を取り込む (再起動後も 1 時間 1 回を守る)。 */
  seed(key: string, atMs: number): void {
    const previous = this.last.get(key);
    if (previous === undefined || atMs > previous) this.last.set(key, atMs);
  }
}

/** 海外通知の間引きキー。 同一トークン・同一国。 */
export function overseasNoticeKey(tokenId: string, country: string | null): string {
  return `${tokenId}\u0000${country ?? "??"}`;
}
