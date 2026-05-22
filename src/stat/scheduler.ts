/**
 * Stat collection scheduler.
 *
 * - 1 分毎に active session を走査し、 stat-collect task を必要なら enqueue する
 * - 「必要」 の条件:
 *    (1) status === 'active'
 *    (2) last_seen_at が 10 分以内 (= 直近に動いている)
 *    (3) この session の最新 stat ts が 10 分以上前 (or null) — = 10 分毎 poll
 *    (4) 当該 session に未配信の stat-collect が pending_tasks に残っていない (二重 enqueue 抑止)
 *
 * 条件 (2) を満たさない (= 10 分以上動いていない) session は skip = 確認しない.
 * これは仕様: 「active でない」 だけでなく「動いてない」 セッションも対象外.
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { StatsRepo } from "../db/stats-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("stat-scheduler");

/** 10 分 = 600 秒. */
export const STAT_POLL_INTERVAL_SEC = 10 * 60;
/** scheduler tick. 1 分毎に判定する. */
export const SCHEDULER_TICK_MS = 60 * 1000;

export interface StatSchedulerDeps {
  sessions: SessionsRepo;
  stats: StatsRepo;
  tasks: TasksRepo;
  /** テスト用. 現在時刻 (秒). 既定はシステム時計. */
  now?: () => number;
  /** テスト用. tick 間隔をテスト時短縮する場合に上書き. */
  tickMs?: number;
}

export interface StatSchedulerHandle {
  stop: () => void;
  /** その瞬間のチェックを 1 度走らせる. enqueue した task の数を返す. */
  runOnce: () => number;
}

export function startStatScheduler(deps: StatSchedulerDeps): StatSchedulerHandle {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const tickMs = deps.tickMs ?? SCHEDULER_TICK_MS;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function runOnce(): number {
    if (stopped) return 0;
    const t = now();
    const cutoff = t - STAT_POLL_INTERVAL_SEC;
    let enqueued = 0;

    const active = deps.sessions.listSessions({ status: "active" });
    for (const s of active) {
      // (2) 直近 10 分で動いていない session は skip
      if (s.last_seen_at < cutoff) continue;

      // (3) 既に 10 分以内に stat 取得済なら skip
      const lastStat = deps.stats.lastTs(s.id);
      if (lastStat !== null && lastStat >= cutoff) continue;

      // (4) 未配信 stat-collect が残っていれば skip
      if (deps.tasks.hasUndelivered(s.id, "stat-collect", t)) continue;

      const role = parseRole(s.metadata);
      deps.tasks.enqueue({
        session_id: s.id,
        kind: "stat-collect",
        payload: {
          role,
          interval_sec: STAT_POLL_INTERVAL_SEC,
          instructions:
            "現在の作業現況を JSON で集計し " +
            "POST http://127.0.0.1:17330/v1/stat/<self_id> に投稿する. " +
            "本文 body は `{ \"payload\": { ... } }` の形式. " +
            "payload に含めるキー (どれも任意): active_repos / open_prs / unmerged_branches / todos_summary / recent_work / note. " +
            "他 session も GET /v1/stat で閲覧するので、 簡潔かつ網羅的に.",
        },
      });
      enqueued++;
    }

    if (enqueued > 0) log.info({ enqueued }, "stat-collect tasks enqueued");
    return enqueued;
  }

  function tick(): void {
    try {
      runOnce();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "tick failed");
    }
  }

  timer = setInterval(tick, tickMs);
  log.info({ tickMs, intervalSec: STAT_POLL_INTERVAL_SEC }, "stat scheduler started");

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      log.info("stat scheduler stopped");
    },
    runOnce,
  };
}

function parseRole(metadata: string | null): string {
  if (!metadata) return "雑用係";
  try {
    const m = JSON.parse(metadata) as { role_label?: string };
    return m.role_label ?? "雑用係";
  } catch { return "雑用係"; }
}
