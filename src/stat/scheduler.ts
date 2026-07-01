/**
 * Stat collection scheduler.
 *
 * 2 つの enqueue 経路:
 *
 * (A) **interval poll** — 10 分毎の通常 poll
 *  (1) status === 'active'
 *  (2) last_seen_at が 10 分以内 (= 直近に動いている)
 *  (3) この session の最新 stat ts が 10 分以上前 (or null)
 *  (4) 当該 session に未配信の stat-collect が pending_tasks に残っていない (二重 enqueue 抑止)
 *  条件 (2) を満たさない (= 10 分以上動いていない) session は skip.
 *
 * (B) **idle trigger** — 5 分指示なし poll (interval とは独立)
 *  (1) status === 'active'
 *  (2) 最後の "prompt" session_event ts (= 最後のユーザ指示) から 5 分以上経過
 *      prompt が一度も無い session は started_at を起点にする.
 *  (3) その lastPrompt 以降に stat-collect が enqueue されていない (1 idle stretch につき 1 回だけ).
 *      → 次のユーザ指示が来れば lastPrompt が更新されて再び発火可能になる.
 *  「自律 AI 活動中で last_seen_at は新しいが指示は来てない」 ケースを拾うので
 *  interval poll の last_seen_at ゲートは適用しない.
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { StatsRepo } from "../db/stats-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("stat-scheduler");

/** 10 分 = 600 秒. */
export const STAT_POLL_INTERVAL_SEC = 10 * 60;
/** idle 判定の閾値. 5 分 = 300 秒. */
export const IDLE_STAT_THRESHOLD_SEC = 5 * 60;
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
    const idleCutoff = t - IDLE_STAT_THRESHOLD_SEC;
    let enqueued = 0;
    let intervalEnqueued = 0;
    let idleEnqueued = 0;

    const active = deps.sessions.listSessions({ status: "active" });
    for (const s of active) {
      const intervalEligible =
        s.last_seen_at >= cutoff &&
        ((): boolean => {
          const lastStat = deps.stats.lastTs(s.id);
          return lastStat === null || lastStat < cutoff;
        })() &&
        !deps.tasks.hasUndelivered(s.id, "stat-collect", t);

      if (intervalEligible) {
        enqueueStatCollect(s, "interval", t);
        intervalEnqueued++;
        enqueued++;
        continue; // 同じ session に同 tick で 2 本投げない
      }

      // idle トリガ: 最後の user prompt から 5 分以上、 かつ lastPrompt 以降に stat-collect 未投入
      const lastPrompt = deps.sessions.lastEventTsByKind(s.id, "prompt") ?? s.started_at;
      if (lastPrompt <= idleCutoff && !deps.tasks.hasTaskSince(s.id, "stat-collect", lastPrompt)) {
        enqueueStatCollect(s, "idle", t);
        idleEnqueued++;
        enqueued++;
      }
    }

    if (enqueued > 0) {
      log.info({ enqueued, interval: intervalEnqueued, idle: idleEnqueued }, "stat-collect tasks enqueued");
    }
    return enqueued;
  }

  function enqueueStatCollect(s: ReturnType<SessionsRepo["listSessions"]>[number], trigger: "interval" | "idle", atNow: number): void {
    const role = parseRole(s.metadata);
    deps.tasks.enqueue({
      session_id: s.id,
      kind: "stat-collect",
      payload: {
        role,
        trigger,
        interval_sec: STAT_POLL_INTERVAL_SEC,
        instructions:
          (trigger === "idle"
            ? "ユーザ指示が 5 分以上途絶えているので現況スナップショットを送ってほしい. "
            : "") +
          "現在の作業現況を JSON で集計し " +
          "POST http://127.0.0.1:11111/v1/stat/<self_id> に投稿する. " +
          "本文 body は `{ \"payload\": { ... } }` の形式. " +
          "payload に含めるキー (どれも任意): active_repos / open_prs / unmerged_branches / todos_summary / recent_work / note. " +
          "他 session も GET /v1/stat で閲覧するので、 簡潔かつ網羅的に.",
      },
      now: atNow,
    });
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
