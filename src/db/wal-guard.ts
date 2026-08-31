/**
 * WAL ガード — checkpoint 飢餓の観測と軽い解消。
 *
 * 2026-09-01 実測: concordia.db-wal が 375MB (DB 本体と同サイズ) に膨らみ、 その間
 * POST /v1/harness/gate や sweeper の書き込みごとに 1.0〜1.3 秒のイベントループ停止が
 * 出ていた。 WAL が自動 checkpoint 閾値 (1000 ページ) を超えたまま長時間リーダーに
 * 阻まれると、 **毎コミットが checkpoint を試行して部分的に失敗する**ため、 書き込みの
 * 度に同期ブロックが起きる。
 *
 * ここでは 5 分ごとに PASSIVE checkpoint (ブロックしない) を打ち、 結果を観測する:
 *   - `log > checkpointed` または `busy` が続く = 長時間リーダーに阻まれている → warn
 *     (どの経路が snapshot を握っているかを追う手掛かりを残す)。
 *   - WAL ファイルが上限を超えている → warn。 journal_size_limit (db/index.ts) が
 *     checkpoint 完了時に切り詰めるので、 超え続けるなら checkpoint が完了していない。
 * 判定は純関数 (assessWalHealth) に分け、 タイマーとログだけをここに置く。
 */

import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval, type SupervisedIntervalHandle } from "../shared/loop-bulkhead.js";
import { WAL_JOURNAL_SIZE_LIMIT_BYTES } from "./index.js";

const log = createChildLogger("wal-guard");
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

export interface WalHealth {
  /** リーダーに阻まれて checkpoint が最後まで進まなかった。 */
  starved: boolean;
  /** WAL ファイルが上限を超えている (checkpoint が完了していない兆候)。 */
  oversized: boolean;
  /** WAL に残っている未 checkpoint フレーム数。 */
  pendingFrames: number;
}

/** 純関数: checkpoint 結果と WAL サイズから健全性を判定する。 */
export function assessWalHealth(
  result: WalCheckpointResult,
  walBytes: number,
  limitBytes: number = WAL_JOURNAL_SIZE_LIMIT_BYTES,
): WalHealth {
  const pendingFrames = Math.max(0, result.log - result.checkpointed);
  return {
    starved: result.busy > 0 || pendingFrames > 0,
    oversized: walBytes > limitBytes,
    pendingFrames,
  };
}

export interface WalGuardOptions {
  db: Pick<Database.Database, "pragma">;
  dbPath: string;
  intervalMs?: number;
  limitBytes?: number;
  /** テスト用: WAL ファイルサイズの取得口。 既定は fs.statSync(`${dbPath}-wal`)。 */
  walBytes?: () => number;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

function readWalBytes(dbPath: string): number {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch (error) {
    // WAL がまだ作られていない状態は正常。 権限・I/O エラーまで 0 bytes と見なすと
    // 監視が無言で無効になるため、 それ以外は bulkhead へ伝播して可視化する。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** 1 回分の観測 (PASSIVE checkpoint + 判定 + ログ)。 例外は呼び出し側の bulkhead が拾う。 */
export function runWalGuardOnce(opts: WalGuardOptions): WalHealth {
  const logger = opts.log ?? log;
  const limit = opts.limitBytes ?? WAL_JOURNAL_SIZE_LIMIT_BYTES;
  const started = Date.now();
  const rows = opts.db.pragma("wal_checkpoint(PASSIVE)") as WalCheckpointResult[];
  const result = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };
  const walBytes = (opts.walBytes ?? (() => readWalBytes(opts.dbPath)))();
  const health = assessWalHealth(result, walBytes, limit);
  const fields = {
    ...result,
    wal_bytes: walBytes,
    limit_bytes: limit,
    pending_frames: health.pendingFrames,
    ms: Date.now() - started,
  };
  if (health.starved || health.oversized) {
    logger.warn(
      fields,
      health.starved
        ? "WAL checkpoint starved: a long-lived read transaction is holding the snapshot (every commit will stall until it ends)"
        : "WAL file exceeds journal_size_limit; checkpoint has not completed since it grew",
    );
  } else if (result.log > 0) {
    logger.info(fields, "WAL checkpoint (passive) completed");
  }
  return health;
}

export function startWalGuard(opts: WalGuardOptions): SupervisedIntervalHandle {
  return startSupervisedInterval("wal-guard", () => runWalGuardOnce(opts), {
    intervalMs: opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    log: { warn: (message) => log.warn(message) },
  });
}
