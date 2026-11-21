import type { NumberedMigration } from "./migrator.js";

/**
 * session_events を (session_id, kind) で引く照会の索引 (spec/plan/2026-11-21-cc-full-scan-elimination.md FS-01)。
 *
 * 統計 (sqlite_stat1) の無い DB では、 planner が選択度の低い idx_events_kind(kind, ts) を選び、
 * その kind の全期間の行 (inject 約4.8万行) を 1 回 105〜300ms かけて読んでいた。
 * 等値の列を先頭に並べた索引を足し、 古い索引は消す。 残すと latestEventsByKind の外側が
 * 統計の有無にかかわらず idx_events_kind を選び続ける (DB の複製で確認)。
 * kind だけで引く照会は src に無い。
 *
 * 式はリテラルで書く。 checksum は version / name / source しか見ないため。
 */
export const sessionEventsKindIndexMigration: NumberedMigration = {
  version: 154,
  name: "session-events-session-kind-index",
  source: "session_events(session_id, kind, ts) を足し idx_events_kind(kind, ts) を消す (CC-SCAN-01 FS-01) v1",
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_kind_ts ON session_events(session_id, kind, ts);
      DROP INDEX IF EXISTS idx_events_kind;
    `);
  },
};
