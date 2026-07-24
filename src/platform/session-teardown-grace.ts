/**
 * Session teardown 猶予窓。
 *
 * `DELETE /v1/sessions/:id` は status を即 "ended" にした後で report 生成
 * (claude CLI + cost 集計、 実測 20〜74s) を回す。 その間に届くものが 2 つある:
 *   1. 子プロセス exit 直後にフラッシュされる「最終応答の transcript frame」
 *   2. session-end フローが投稿する「独白 (報告)」 — 設計上 ended 後にしか来ない
 * relay/egress を status===active の厳密判定にすると両方が必ず捨てられ、
 * ユーザから見て「返事が来ない / 報告が出ない」になる (2026-07-22 障害)。
 * Discord 側 channel が生きている限り、 ended から一定時間はリレーを許可する。
 */

export const TEARDOWN_RELAY_GRACE_SEC = 180;

/**
 * ended / lost (sweeper が teardown 中に lost へ倒すことがある) のみ猶予対象。
 * ended_at が無い行は判定不能なので猶予しない (安全側)。
 */
export function withinTeardownGrace(
  sessionStatus: string | null | undefined,
  endedAtSec: number | null | undefined,
  nowSec: number,
): boolean {
  if (sessionStatus !== "ended" && sessionStatus !== "lost") return false;
  if (typeof endedAtSec !== "number" || !Number.isFinite(endedAtSec)) return false;
  return nowSec - endedAtSec <= TEARDOWN_RELAY_GRACE_SEC;
}
