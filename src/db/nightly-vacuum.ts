/**
 * 深夜の空き率点検 (旧: 深夜の一括 VACUUM)。
 *
 * 経緯:
 * - 2026-08-24 (neco 決定): ログ保持 7 日の刈り込み (sweeper) は行を消すだけで DB ファイルが
 *   縮まないため、 毎日 03:00 JST に本体プロセスで wal_checkpoint(TRUNCATE) + VACUUM を一括で行う。
 * - 2026-11-22 (FS-36 / CC-SCAN-11・12、 ユーザ承認済み): 上の決定を改める。 直近 28 夜で
 *   VACUUM は 1 回 32〜492 秒イベントループを止め (HTTP・Discord・harness gate がすべて停止)、
 *   回収できたのは最大でも 3.47% (8 夜は 0 bytes)、 11-12 は一時領域不足で失敗した。 回収量は
 *   7 日分の刈り込み量で頭打ちになる一方、 所要は DB の大きさに比例して伸び続ける。
 *   空きページは auto_vacuum=NONE でも次の挿入で再利用されるので、 回収しなくてもファイルは
 *   横ばいになる。
 *
 * 現在の振る舞い (本体プロセスでは VACUUM も TRUNCATE checkpoint も一切しない):
 * - freelist_count / page_count (どちらもヘッダを読むだけの O(1)) から空き率を出す。
 * - 空き率が VACUUM_RECOMMEND_FREE_RATIO 未満なら skip を info で残す。 TRUNCATE checkpoint も
 *   打たない (wal-guard の 5 分ごとの PASSIVE で足り、 TRUNCATE は busy_timeout の間リーダーを
 *   同期で待つ)。
 * - 以上なら warn で保守窓の VACUUM を求める。 実行は Cc を止めた保守窓で Excubitor の
 *   peer operations (stop → VACUUM の CLI → start) を通して人が行う。 VACUUM は実行中ずっと
 *   書き込みロックを持つので、 worker の別接続に逃がしても本体の書き込みは止まる。
 */

import { Cron } from "croner";
import type Database from "better-sqlite3";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("nightly-vacuum");

/** 毎日 03:00 JST。 他の夜間ジョブ (Genius 4:10 / 脆弱性 5:10) より前に置く。 */
export const NIGHTLY_VACUUM_CRON = "0 3 * * *";

/**
 * 保守窓の VACUUM を求める空き率 (freelist_count / page_count) の下限。
 * 直近 28 夜の回収率は全夜 10% 未満で、 この値なら普段は skip になる。
 */
export const VACUUM_RECOMMEND_FREE_RATIO = 0.1;

const TIMEZONE = "Asia/Tokyo";

export interface NightlyVacuumOptions {
  db: Database.Database;
  /** 点検対象 DB のファイルパス (保守窓での VACUUM 依頼ログに載せる)。 */
  dbPath: string;
}

export interface FreePageStats {
  freelist_pages: number;
  page_count: number;
  free_ratio: number;
}

export type NightlyVacuumOutcome =
  | ({ action: "skipped" } & FreePageStats)
  | ({ action: "maintenance_recommended" } & FreePageStats)
  | { action: "failed"; error: string };

export interface NightlyVacuumHandle {
  stop: () => void;
  /** テスト・手動実行用。 cron を待たずに 1 回点検する (VACUUM はしない)。 */
  runOnce: () => Promise<NightlyVacuumOutcome>;
}

/** ヘッダの 2 値だけを読む。 表を走査しないので DB の大きさに依らず O(1)。 */
export function readFreePageStats(db: Database.Database): FreePageStats {
  const freelistPages = Number(db.pragma("freelist_count", { simple: true }));
  const pageCount = Number(db.pragma("page_count", { simple: true }));
  // page_count が 0 の DB (未初期化) は空きも無いので 0 とする。 NaN を閾値比較に流さない。
  const freeRatio = pageCount > 0 ? freelistPages / pageCount : 0;
  return { freelist_pages: freelistPages, page_count: pageCount, free_ratio: freeRatio };
}

export function inspectFreePages(opts: NightlyVacuumOptions): NightlyVacuumOutcome {
  let stats: FreePageStats;
  try {
    stats = readFreePageStats(opts.db);
  } catch (error) {
    const message = (error as Error).message;
    log.error({ err: message }, "nightly vacuum inspection failed");
    return { action: "failed", error: message };
  }
  if (stats.free_ratio < VACUUM_RECOMMEND_FREE_RATIO) {
    log.info({ ...stats, threshold: VACUUM_RECOMMEND_FREE_RATIO }, "nightly vacuum skipped");
    return { action: "skipped", ...stats };
  }
  log.warn(
    { ...stats, threshold: VACUUM_RECOMMEND_FREE_RATIO, db_path: opts.dbPath },
    "vacuum recommended: run VACUUM in a maintenance window via Excubitor peer operations (stop -> VACUUM -> start)",
  );
  return { action: "maintenance_recommended", ...stats };
}

export function startNightlyVacuum(opts: NightlyVacuumOptions): NightlyVacuumHandle {
  const runOnce = async (): Promise<NightlyVacuumOutcome> => inspectFreePages(opts);

  const job = new Cron(NIGHTLY_VACUUM_CRON, { timezone: TIMEZONE }, () => {
    runOnce().catch((error: unknown) => log.error({ err: (error as Error).message }, "nightly vacuum inspection failed"));
  });
  log.info(
    { cron: NIGHTLY_VACUUM_CRON, timezone: TIMEZONE, threshold: VACUUM_RECOMMEND_FREE_RATIO },
    "nightly vacuum inspection scheduled",
  );

  return {
    stop: () => job.stop(),
    runOnce,
  };
}
