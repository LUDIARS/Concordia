import type { NumberedMigration } from "./migrator.js";

/**
 * Muse の試遊結果の中継台帳 (spec/feature/playtest-review-notify.md — Muse の結果の中継)。
 *
 * 1 指令 1 行 (instruction_id 主キー、CC-MUSE-RELAY-INV-01)。 Voluptas への保存と告知の進み具合を持ち、
 * 再起動を跨いだ二重告知を止める (announce_state が announcing のまま残った行は結果不明として failed にする)。
 * 時刻は epoch ms。
 */
export const musePlaytestRelaysMigration: NumberedMigration = {
  version: 157,
  name: "muse-playtest-relays",
  source: "muse_playtest_relays (Muse の試遊結果の中継台帳) v1",
  up(db) {
    db.exec(`
      CREATE TABLE muse_playtest_relays (
        instruction_id  TEXT PRIMARY KEY,
        run_id          TEXT,
        finished_at     TEXT NOT NULL,
        review_json     TEXT,
        voluptas_state  TEXT NOT NULL CHECK (voluptas_state IN ('pending', 'saved', 'failed', 'skipped')),
        voluptas_id     TEXT,
        announce_state  TEXT NOT NULL CHECK (announce_state IN ('pending', 'announcing', 'delivered', 'failed', 'skipped')),
        announce_result TEXT,
        error           TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX muse_playtest_relays_due ON muse_playtest_relays(voluptas_state, announce_state, next_attempt_at);
    `);
  },
};
