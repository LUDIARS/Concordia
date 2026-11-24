import type { NumberedMigration } from "./migrator.js";

/**
 * Cc v5 の依頼窓口と管制カード (spec/plan/2026-11-24-control-session-to-dots.md 実装メモ 4)。
 *
 * - desk_requests: 依頼窓口に人間が書いた 1 件。受付キー (request_key) と起動 ID (spawn_id) で冪等 (CC-V5-INV-01)。
 * - control_cards: 人間のアクション / 判断が要る 1 件。解決の正本は出所で、カードは参照と捌きと催促の予定だけを持つ
 *   (CC-V5-INV-02 / 03)。同一性は (source_kind, source_key)。
 * - control_card_reminders: Cc が出した催促の送信記録 (CC-V5-INV-05 の間隔の根拠)。
 *
 * 時刻はすべて epoch ms。
 */
export const v5DeskCardsMigration: NumberedMigration = {
  version: 156,
  name: "v5-desk-cards",
  source: "desk_requests / control_cards / control_card_reminders (Cc v5 依頼窓口と管制カード) v1",
  up(db) {
    db.exec(`
      CREATE TABLE desk_requests (
        id                 TEXT PRIMARY KEY,
        request_key        TEXT NOT NULL UNIQUE,
        origin             TEXT NOT NULL CHECK (origin IN ('web', 'discord')),
        requester          TEXT NOT NULL,
        provider           TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        body               TEXT NOT NULL,
        state              TEXT NOT NULL CHECK (state IN ('accepted', 'launching', 'launch_unknown', 'running', 'finished', 'launch_failed')),
        spawn_id           TEXT UNIQUE,
        session_id         TEXT,
        launch_deadline_at INTEGER,
        error              TEXT,
        discord_thread_id  TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        revision           INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX desk_requests_state ON desk_requests(state, created_at);
      CREATE INDEX desk_requests_session ON desk_requests(session_id);

      CREATE TABLE control_cards (
        id            TEXT PRIMARY KEY,
        source_kind   TEXT NOT NULL,
        source_key    TEXT NOT NULL,
        card_kind     TEXT NOT NULL CHECK (card_kind IN ('human_action', 'human_judgment')),
        summary       TEXT NOT NULL,
        session_id    TEXT,
        project       TEXT,
        link          TEXT,
        state         TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        raised_at     INTEGER NOT NULL,
        closed_at     INTEGER,
        close_reason  TEXT,
        priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
        assignee      TEXT,
        remind_at     INTEGER,
        reminder_text TEXT,
        card_group    TEXT,
        triaged_by    TEXT,
        triaged_at    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE (source_kind, source_key)
      );
      CREATE INDEX control_cards_state ON control_cards(state, raised_at);
      CREATE INDEX control_cards_session ON control_cards(session_id);

      CREATE TABLE control_card_reminders (
        id      INTEGER PRIMARY KEY,
        card_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        text    TEXT NOT NULL
      );
      CREATE INDEX control_card_reminders_card ON control_card_reminders(card_id, sent_at DESC);
    `);
  },
};
