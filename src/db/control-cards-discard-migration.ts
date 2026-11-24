import type { NumberedMigration } from "./migrator.js";

/**
 * 管制カードの破棄 (spec/plan/2026-11-24-control-session-to-dots.md 実装メモ 14、CC-V5-INV-08)。
 *
 * control_cards.state の CHECK に 'discarded' を足すため表を作り直す。列 discarded_at (epoch ms) /
 * discard_reason (session_inactive | session_unresolved) を close_reason の後ろに足す。既存の行はそのまま移す
 * (破棄の判定は巡回の同期が行い、ここでは値を作らない)。control_card_reminders は card_id で参照するだけなので触らない。
 */
export const controlCardsDiscardMigration: NumberedMigration = {
  version: 158,
  name: "control-cards-discard",
  source: "control_cards.state discarded + discarded_at / discard_reason (Cc v5 実装メモ 14) v1",
  up(db) {
    db.exec(`
      CREATE TABLE control_cards_v158 (
        id             TEXT PRIMARY KEY,
        source_kind    TEXT NOT NULL,
        source_key     TEXT NOT NULL,
        card_kind      TEXT NOT NULL CHECK (card_kind IN ('human_action', 'human_judgment')),
        summary        TEXT NOT NULL,
        session_id     TEXT,
        project        TEXT,
        link           TEXT,
        state          TEXT NOT NULL CHECK (state IN ('open', 'closed', 'discarded')),
        raised_at      INTEGER NOT NULL,
        closed_at      INTEGER,
        close_reason   TEXT,
        discarded_at   INTEGER,
        discard_reason TEXT CHECK (discard_reason IS NULL OR discard_reason IN ('session_inactive', 'session_unresolved')),
        priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
        assignee       TEXT,
        remind_at      INTEGER,
        reminder_text  TEXT,
        card_group     TEXT,
        triaged_by     TEXT,
        triaged_at     INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE (source_kind, source_key)
      );
      INSERT INTO control_cards_v158 (id, source_kind, source_key, card_kind, summary, session_id, project, link, state,
          raised_at, closed_at, close_reason, priority, assignee, remind_at, reminder_text, card_group, triaged_by, triaged_at,
          created_at, updated_at)
        SELECT id, source_kind, source_key, card_kind, summary, session_id, project, link, state,
          raised_at, closed_at, close_reason, priority, assignee, remind_at, reminder_text, card_group, triaged_by, triaged_at,
          created_at, updated_at
        FROM control_cards;
      DROP TABLE control_cards;
      ALTER TABLE control_cards_v158 RENAME TO control_cards;
      CREATE INDEX control_cards_state ON control_cards(state, raised_at);
      CREATE INDEX control_cards_session ON control_cards(session_id);
    `);
  },
};
