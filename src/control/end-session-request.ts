/**
 * 「セッション終了」と**発言された**ときに、指示の最後で `/end-session` 相当まで
 * 到達させる仕組み。
 *
 * これまでは発言をそのまま inject するだけで、実際に終了させるのはセッション自身の
 * 責務だった。 セッションが session-end skill を回さない / 回しきれない場合、プロセスが
 * 残り続け、人間が改めて `/end-session` を叩く必要があった (2026-08-09 neco 指摘)。
 *
 * ここでは終了を**即時には**行わない。 発言時点では印だけ付け、そのターンが終わって
 * セッションが静かになってから終了させる — 「指示の最後に実行する」を満たすため。
 * 静かにならないまま上限時間を超えた場合も終了させる (残り続けるのを防ぐのが目的)。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { createChildLogger } from "../shared/logger.js";
import { END_SESSION_REQUESTED_AT_KEY, readEndSessionRequestedAt } from "../shared/end-session-request.js";
export {
  detectsEndSessionRequest,
  END_SESSION_REQUESTED_AT_KEY,
  markEndSessionRequested,
  readEndSessionRequestedAt,
} from "../shared/end-session-request.js";

const log = createChildLogger("end-session-request");

/** ターン終了とみなす無活動時間の既定 (秒)。 */
const DEFAULT_IDLE_SEC = 90;
/** 静かにならなくても終了させる上限 (秒)。 */
const DEFAULT_MAX_WAIT_SEC = 15 * 60;
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 「セッション終了」の指示か。
 *
 * 打ち消し (「終了しないで」「終了は不要」) を含む文は対象外にする — 誤って終了させる
 * 方が、拾い漏らして人間が `/end-session` を叩くよりはるかに損害が大きい。
 */
export interface EndSessionDueOptions {
  nowSec: number;
  idleSec?: number;
  maxWaitSec?: number;
}

/**
 * 終了させてよい session を選ぶ。 判定材料は last_seen_at (traffic の最終観測) だけで、
 * LLM の自己申告には依存しない。
 */
export function selectDueEndSessionRequests(
  rows: readonly SessionRow[],
  options: EndSessionDueOptions,
): SessionRow[] {
  const idleSec = options.idleSec ?? DEFAULT_IDLE_SEC;
  const maxWaitSec = options.maxWaitSec ?? DEFAULT_MAX_WAIT_SEC;
  return rows.filter((row) => {
    if (row.status !== "active") return false;
    const requestedAt = readEndSessionRequestedAt(row.metadata);
    if (requestedAt === null) return false;
    if (options.nowSec - requestedAt >= maxWaitSec) return true;
    // 発言そのものが last_seen_at を進めるので、要求より後の静止だけを見る。
    const quietSince = Math.max(row.last_seen_at, requestedAt);
    return options.nowSec - quietSince >= idleSec;
  });
}

export interface EndSessionRequestWatchDeps {
  sessions: SessionsRepo;
  /** 実際の終了処理 (control/end-session-command.ts の endSessionNow を束ねたもの)。 */
  endSession: (session: SessionRow, reason: string) => Promise<unknown>;
  idleSec?: number;
  maxWaitSec?: number;
  intervalMs?: number;
  nowSec?: () => number;
}

/** 印の付いた session を、静かになった時点で閉じるウォッチャ。 */
export function startEndSessionRequestWatch(deps: EndSessionRequestWatchDeps): { stop(): void } {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const inFlight = new Set<string>();

  const tick = async (): Promise<void> => {
    let active: SessionRow[];
    try {
      active = deps.sessions.listSessions({ status: "active" });
    } catch (error) {
      log.warn(`end-session request scan failed: ${(error as Error).message}`);
      return;
    }
    const due = selectDueEndSessionRequests(active, {
      nowSec: nowSec(),
      idleSec: deps.idleSec,
      maxWaitSec: deps.maxWaitSec,
    });
    for (const session of due) {
      if (inFlight.has(session.id)) continue;
      inFlight.add(session.id);
      try {
        await deps.endSession(session, "spoken session-end request");
        log.info(`ended session ${session.id} from a spoken session-end request`);
      } catch (error) {
        // 次周期で再試行する。 印は残したままにしておく (終了させ切るのが目的)。
        log.warn(`spoken session-end failed for ${session.id}: ${(error as Error).message}`);
      } finally {
        inFlight.delete(session.id);
      }
    }
  };

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
