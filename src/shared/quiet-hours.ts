/**
 * 強制ルール: 深夜帯 (23:00–翌05:00) はチャット行動頻度を 1/10 に落とす.
 *
 * Concordia のチャット発話 / 軽レビュー / tick フックの頻度は、 すべて
 * Concordia 側の静的アルゴリズム (dispatcher.ts / rules/engine.ts) で決まる.
 * AI セッションの自己判断ではなく Concordia が一律適用する「強制ルール」として、
 * 深夜帯はその行動頻度に本係数を掛けて 1/10 に抑制する.
 *
 * 適用方針:
 *  - 確率ベースのトリガ (dispatcher の各確率) は確率に係数を掛ける.
 *  - tick ベースのトリガ (rule engine の tick rule) は発火間隔を 1/係数 倍に伸ばす.
 *  - event ベースのトリガ (rule engine の event rule) は係数で確率的に間引く.
 *
 * 対象は「能動的・頻度ベースの雑談/レビュー」のみ. session 離脱通知や
 * daily-report などの ライフサイクル通知は間引かない (取りこぼすと困るため).
 *
 * 時刻判定はサーバのローカルタイム (運用想定 JST) で行う.
 */

/** 深夜帯の開始時刻 (この時刻「以降」). */
export const QUIET_HOURS_START = 23;

/** 深夜帯の終了時刻 (この時刻「未満」). 05:00 ちょうどで通常頻度に戻る. */
export const QUIET_HOURS_END = 5;

/** 深夜帯に適用する行動頻度の係数 (= 1/10). */
export const QUIET_HOURS_FACTOR = 0.1;

/** 指定時刻が深夜帯 (23:00–翌05:00) に入っているか. */
export function isQuietHours(now: Date = new Date()): boolean {
  const h = now.getHours();
  return h >= QUIET_HOURS_START || h < QUIET_HOURS_END;
}

/**
 * チャット行動頻度に掛ける係数を返す.
 * 深夜帯は {@link QUIET_HOURS_FACTOR} (1/10)、 それ以外は 1 (= 通常頻度).
 */
export function actionFrequencyMultiplier(now: Date = new Date()): number {
  return isQuietHours(now) ? QUIET_HOURS_FACTOR : 1;
}
