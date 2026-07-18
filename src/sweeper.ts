/**
 * Background sweeper.
 *
 * - active で last_seen_at が古い → status=lost + lost event 追加 + recovery を試みる
 * - lost で last_seen_at が更に古い → status=abandoned
 * - 古い session_events を auto-purge
 */

import { open } from "node:fs/promises";
import type { SessionsRepo } from "./db/sessions-repo.js";
import type { TasksRepo } from "./db/tasks-repo.js";
import type { RulesRepo } from "./db/rules-repo.js";
import type { StatsRepo } from "./db/stats-repo.js";
import type { TranscriptLogsRepo } from "./db/transcript-logs-repo.js";
import { getProvider } from "./providers/index.js";
import { createChildLogger } from "./shared/logger.js";
import { eventBus } from "./events.js";
import { createLoopBulkhead } from "./shared/loop-bulkhead.js";
import { isSessionEndPending, SESSION_END_PENDING_AT_KEY } from "./control/session-end-process.js";

const log = createChildLogger("sweeper");

export interface SweeperOptions {
  repo: SessionsRepo;
  tasks: TasksRepo;
  transcriptLogs: Pick<TranscriptLogsRepo, "purgeOlderThan">;
  rules: Pick<RulesRepo, "purgeLogsOlderThan">;
  stats: Pick<StatsRepo, "purgeOlderThan">;
  intervalMs: number;
  lostAfterSec: number;
  abandonedAfterSec: number;
  /** lost/abandoned 状態で last_seen_at がこの秒数以上古い session を DELETE する閾値. default 30 分. */
  lostPurgeAfterSec: number;
  purgeAfterDays: number;
  transcriptRetentionDays: number;
  rulesLogRetentionDays: number;
  sessionStatsRetentionDays: number;
}

export function startSweeper(opts: SweeperOptions): { stop: () => void; runOnce: () => Promise<void> } {
  let timer: NodeJS.Timeout | null = null;
  const bulkhead = createLoopBulkhead("sweeper", {
    log: { warn: (message) => log.warn(message) },
    onHalt: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  });

  async function tick(): Promise<void> {
    await bulkhead.run(runOnce);
  }

  async function runOnce(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // 1. active → lost
    const lostCutoff = now - opts.lostAfterSec;
    for (const s of opts.repo.findStaleActive(lostCutoff)) {
      opts.repo.setStatus(s.id, "lost", now);
      opts.repo.appendEvent({
        session_id: s.id,
        ts: now,
        kind: "lost",
        payload: { last_seen_at: s.last_seen_at },
      });
      const recovered = await tryRecover(s.id, s.provider, s.repo_path, s.transcript_path);
      if (recovered) {
        opts.repo.appendEvent({
          session_id: s.id,
          ts: now,
          kind: "recovered",
          payload: recovered,
        });
      }
      // 他 active session に「離脱しました」通知
      eventBus.emit({ type: "session.lost", session_id: s.id, ts: now });
      log.info(
        { session_id: s.id, last_seen_at: s.last_seen_at, recovered: !!recovered },
        "session marked lost",
      );
    }

    // session-end 完了通知が来なかった ended session は、traffic / WS 切断後に lost へ移す。
    // Lictor の停止は時間ベースの ended 回収ではなく、lost 専用 reaper に委ねる。
    for (const candidate of opts.repo.findStaleEndedWithMetadataKey(lostCutoff, SESSION_END_PENDING_AT_KEY)) {
      const current = opts.repo.findSession(candidate.id);
      if (!current || current.status !== "ended" || current.ws_clients > 0 || !isSessionEndPending(current.metadata)) continue;
      opts.repo.setStatus(current.id, "lost", now);
      opts.repo.appendEvent({
        session_id: current.id,
        ts: now,
        kind: "lost",
        payload: { last_seen_at: current.last_seen_at, reason: "session-end completion not received" },
      });
      eventBus.emit({ type: "session.lost", session_id: current.id, ts: now });
      log.info({ session_id: current.id, last_seen_at: current.last_seen_at }, "incomplete session-end marked lost");
    }

    // 2. lost → abandoned
    const abandonedCutoff = now - opts.abandonedAfterSec;
    const abandonedCount = opts.repo.abandonLost(abandonedCutoff);
    if (abandonedCount > 0) {
      log.info({ count: abandonedCount }, "lost sessions abandoned");
    }

    // 2.5 lost/abandoned で 30 分経過 → 完全削除 (UI を綺麗に保つため)
    const stalePurgeCutoff = now - opts.lostPurgeAfterSec;
    const purgedSessions = opts.repo.purgeStale(stalePurgeCutoff);
    if (purgedSessions > 0) {
      log.info({ count: purgedSessions }, "lost/abandoned sessions purged");
    }

    // 3. event purge
    const eventPurgeCutoff = now - opts.purgeAfterDays * 86400;
    const purged = opts.repo.purgeEventsOlderThan(eventPurgeCutoff);
    if (purged > 0) {
      log.info({ purged }, "old events purged");
    }

    const transcriptPurged = opts.transcriptLogs.purgeOlderThan(
      now - opts.transcriptRetentionDays * 86400,
    );
    const rulesPurged = opts.rules.purgeLogsOlderThan(now - opts.rulesLogRetentionDays * 86400);
    const statsPurged = opts.stats.purgeOlderThan(now - opts.sessionStatsRetentionDays * 86400);
    if (transcriptPurged + rulesPurged + statsPurged > 0) {
      log.info(
        { transcriptPurged, rulesPurged, statsPurged },
        "old transcript, rule, and session stat rows purged",
      );
    }

    // 4. expired pending_tasks を purge
    const expired = opts.tasks.purgeExpired(now);
    if (expired > 0) {
      log.info({ expired }, "expired tasks purged");
    }

    // 5. 配信済だが応答が無い pending_tasks を retry 対象として delivered_at=NULL に戻す.
    //    既定: 5 分応答なしで再送、 最大 3 回まで.
    //    対象 kind は stat-collect だけに絞る (chat 系は応答性 ambiguous なので touch しない).
    const requeued = opts.tasks.requeueForRetry({ kinds: ["stat-collect"], now });
    if (requeued.length > 0) {
      log.info({ count: requeued.length, kind: "stat-collect" }, "tasks requeued for retry");
    }
  }

  timer = setInterval(() => void tick(), opts.intervalMs);
  log.info({ intervalMs: opts.intervalMs }, "sweeper started");

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}

/**
 * recovery 用に transcript を読む上限バイト数。 parseTranscript は末尾から走査する
 * ため末尾チャンクで足りる (巨大 transcript の全量読みは 2026-07-16 障害の主因)。
 * 上限以下のファイルは全量 = 旧実装と同一結果。 超える場合のみ末尾のみ読み、
 * jsonl_lines が下限値になる (recovery 情報としては許容)。
 */
const RECOVERY_READ_CAP_BYTES = 4 * 1024 * 1024;

async function tryRecover(
  sessionId: string,
  provider: string,
  cwd: string,
  transcriptPath: string | null,
): Promise<unknown | null> {
  const p = getProvider(provider);
  if (!p) return null;
  const path = transcriptPath ?? (await p.transcriptPath(sessionId, cwd));
  if (!path) return null;
  try {
    const content = await readTailCapped(path, RECOVERY_READ_CAP_BYTES);
    if (content === null) return null;
    return await p.parseTranscript(content);
  } catch (err) {
    log.warn({ err: (err as Error).message, path }, "recovery failed");
    return null;
  }
}

/** 末尾 maxBytes までを読む (それ以下なら全量)。 読めなければ null。 */
async function readTailCapped(path: string, maxBytes: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return null; // 旧 existsSync ガード相当 (無ければ黙って null)。
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.allocUnsafe(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8", 0, bytesRead);
    if (start > 0) {
      // 途中から読んだ先頭の欠け行を捨てる (行境界に揃える)。
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } finally {
    await fh.close();
  }
}
