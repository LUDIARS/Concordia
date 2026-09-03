// @implements spec/feature/revisor-test-forum-sync.md — Runtime boundary
/**
 * 読み取り専用 upstream 取得の重複畳み込み (TTL + single-flight)。
 *
 * 責務は 1 つ: 「同じキーの取得を、TTL の間は 1 回に畳む」。 何を取得するかは
 * 呼び出し側の loader が持つので、 この module は HTTP も Revisor も知らない。
 *
 * 背景: test-forum の定期 reconcile は Discord client (本社 + 子会社) ごとに走り、
 * 1 回の reconcile が `/v1/local-prs` を 2 回 (open 用と terminal 用) + `/v1/repositories`
 * を 1 回叩いていた。 応答は約 1MB あり、 client 数 × 3 回分の JSON パースがそのまま
 * メインスレッドに乗ってイベントループを 1〜2 秒止めていた
 * ([[2026-09-03-test-forum-reconcile-event-loop-stall]])。
 *
 * 失敗はキャッシュしない。 失敗を握ってスタブや空配列に落とすと「動いているのに中身が
 * 空」になるため、 待ち合わせ中の全員へ同じ error を伝播させる (fail-fast)。
 */

export interface SharedReadCacheOptions {
  /** 取得結果を再利用する時間 (ms)。 0 以下なら再利用はせず single-flight だけが効く。 */
  ttlMs: number;
  /** epoch-ms クロック (テスト用)。 既定 Date.now。 */
  now?: () => number;
}

interface CacheEntry {
  fetchedAt: number;
  value: unknown;
}

export class SharedReadCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fresh = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(options: SharedReadCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * `key` の値を返す。 TTL 内の結果があればそれを、 取得中なら同じ Promise に合流し、
   * どちらも無ければ `load` を 1 回だけ呼ぶ。
   */
  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.fresh.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached.value as T;

    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;

    const pending = load()
      .then((value) => {
        // 途中で invalidate された取得結果は載せ直さない (古い値の復活を防ぐ)。
        if (this.inflight.get(key) === pending) {
          this.fresh.set(key, { fetchedAt: this.now(), value });
        }
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
      });
    this.inflight.set(key, pending);
    return pending;
  }

  /**
   * キャッシュを捨てる。 キー省略で全件。
   *
   * 即時性が要る契機 (PR 状態変化の通知) で呼ぶ。 走行中の取得も「無かったこと」に
   * するので、 次の `get` は必ず新しく取り直す。
   */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.fresh.clear();
      this.inflight.clear();
      return;
    }
    this.fresh.delete(key);
    this.inflight.delete(key);
  }
}
