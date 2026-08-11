/**
 * session-end 完了通知が猶予内に来なかった ended session の保険回収。
 *
 * 通常経路は `POST /v1/sessions/:id/session-end-done` が
 * `stopCompletedSessionProcesses` を呼んで PID を止める。この通知だけを引き金にすると、
 * 通知経路が死んだ瞬間に回収手段が 0 本になる (2026-08-08: 残留 21 ツリー / 149 プロセス)。
 *
 * ここは「通知が来なかった場合」だけを担当する時間ベースの保険で、停止の実処理と
 * PID 世代の再検証は通常経路と同じ `stopCompletedSessionProcesses` に委ねる。
 * 判定は `session_end_pending_at` の経過時間で行い、`last_seen_at` には依存しない。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import {
  SESSION_END_PENDING_AT_KEY,
  isSessionEndPendingOlderThan,
  stopCompletedSessionProcesses,
  type CompletedSessionStopDeps,
  type CompletedSessionStopResult,
} from "./session-end-process.js";

/** この回収が必要とする repo 操作だけを表す構造的境界 (テスト差し替え用)。 */
export type ExpiredSessionEndRepo = Pick<
  SessionsRepo,
  "findEndedWithPendingMarkerOlderThan" | "findSession" | "mergeMetadata"
>;

/** session-end 完了通知を待つ既定の猶予 (秒) = 5 分。 */
export const DEFAULT_SESSION_END_GRACE_SEC = 300;

export interface ExpiredSessionEndReapResult {
  /** 猶予切れとして評価した session。 */
  candidates: string[];
  /** 停止まで到達した session (既に終了していた PID を含む)。 */
  stopped: Array<{ sessionId: string; stop: CompletedSessionStopResult }>;
  /** 停止に失敗し、マーカーを残して次周期に持ち越した session。 */
  failed: Array<{ sessionId: string; stop: CompletedSessionStopResult }>;
}

export interface ExpiredSessionEndReapOptions {
  dryRun: boolean;
  nowSec: number;
  graceSec: number;
}

/**
 * 猶予切れの ended session の記録済み PID を停止し、成功したものだけマーカーを消す。
 *
 * 失敗時にマーカーを残すのは、次周期で再試行できるようにするため。
 */
export async function reapExpiredSessionEnds(
  deps: {
    repo: ExpiredSessionEndRepo;
    stopDeps?: CompletedSessionStopDeps;
  },
  opts: ExpiredSessionEndReapOptions,
): Promise<ExpiredSessionEndReapResult> {
  const result: ExpiredSessionEndReapResult = { candidates: [], stopped: [], failed: [] };
  // This path can terminate a process tree. Invalid timing input must fail safe
  // instead of treating every pending marker as expired.
  if (!Number.isFinite(opts.nowSec) || !Number.isFinite(opts.graceSec) || opts.graceSec < 0) return result;
  const cutoff = opts.nowSec - opts.graceSec;
  for (const row of deps.repo.findEndedWithPendingMarkerOlderThan(cutoff, SESSION_END_PENDING_AT_KEY)) {
    result.candidates.push(row.id);
    if (opts.dryRun) continue;
    // kill 直前に再取得し、active 復帰・WS 再接続・マーカー解消/更新を見送る。
    const current = deps.repo.findSession(row.id);
    if (
      !current
      || current.status !== "ended"
      || current.ws_clients > 0
      || !isSessionEndPendingOlderThan(current.metadata, cutoff)
    ) continue;
    const stop = await stopCompletedSessionProcesses(current.metadata, deps.stopDeps);
    if (stop.ok) {
      deps.repo.mergeMetadata(row.id, { [SESSION_END_PENDING_AT_KEY]: null });
      result.stopped.push({ sessionId: row.id, stop });
    } else {
      result.failed.push({ sessionId: row.id, stop });
    }
  }
  return result;
}
