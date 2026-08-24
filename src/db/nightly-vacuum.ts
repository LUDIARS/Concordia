/**
 * 深夜の一括 VACUUM (neco 決定 2026-08-24)。
 *
 * ログ保持 7 日の刈り込み (sweeper) は行を消すだけで DB ファイルは縮まない。
 * VACUUM は better-sqlite3 の同期実行で数十秒〜分単位イベントループを占有するため、
 * 日中には走らせず、 毎日 03:00 JST に一括で行う。 日中の実行は
 * drop-obsolete-excubitor CLI の quiet-hours ガードと同じ理由で禁止する。
 */

import { statSync } from "node:fs";
import { Cron } from "croner";
import type Database from "better-sqlite3";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("nightly-vacuum");

/** 毎日 03:00 JST。 他の夜間ジョブ (Genius 4:10 / 脆弱性 5:10) より前に置く。 */
export const NIGHTLY_VACUUM_CRON = "0 3 * * *";

const TIMEZONE = "Asia/Tokyo";

export interface NightlyVacuumOptions {
  db: Database.Database;
  /** VACUUM 対象 DB のファイルパス (サイズ計測用)。 */
  dbPath: string;
}

export interface NightlyVacuumHandle {
  stop: () => void;
  /** テスト・手動実行用。 cron を待たずに 1 回 VACUUM する。 */
  runOnce: () => void;
}

function fileSizeBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null; // in-memory DB などパスが実在しない場合はサイズ計測だけ諦める
  }
}

export function startNightlyVacuum(opts: NightlyVacuumOptions): NightlyVacuumHandle {
  function runOnce(): void {
    const before = fileSizeBytes(opts.dbPath);
    const startedAt = Date.now();
    try {
      // WAL に溜まった分を先に本体へ書き戻してから領域を回収する。
      opts.db.pragma("wal_checkpoint(TRUNCATE)");
      opts.db.exec("VACUUM");
    } catch (error) {
      log.error({ err: (error as Error).message }, "nightly vacuum failed");
      return;
    }
    const after = fileSizeBytes(opts.dbPath);
    log.info(
      {
        duration_ms: Date.now() - startedAt,
        before_bytes: before,
        after_bytes: after,
        reclaimed_bytes: before !== null && after !== null ? Math.max(0, before - after) : null,
      },
      "nightly vacuum completed",
    );
  }

  const job = new Cron(NIGHTLY_VACUUM_CRON, { timezone: TIMEZONE }, () => runOnce());
  log.info({ cron: NIGHTLY_VACUUM_CRON, timezone: TIMEZONE }, "nightly vacuum scheduled");

  return {
    stop: () => job.stop(),
    runOnce,
  };
}
