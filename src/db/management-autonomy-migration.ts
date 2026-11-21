import type { NumberedMigration } from "./migrator.js";

export const managementAutonomyMigration: NumberedMigration = {
  version: 151,
  name: "management-autonomy",
  source: "management mission autonomy and autonomous loop breaker (CC-MGMT-05/09) v1",
  up(db) {
    db.exec(`
      ALTER TABLE management_missions ADD COLUMN allow_ai_only_evidence INTEGER NOT NULL DEFAULT 0 CHECK (allow_ai_only_evidence IN (0, 1));
      ALTER TABLE management_missions ADD COLUMN autonomous_evaluation INTEGER NOT NULL DEFAULT 0 CHECK (autonomous_evaluation IN (0, 1));

      CREATE TABLE autonomous_loop_breaker (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 3,
        target_oscillation INTEGER NOT NULL DEFAULT 3,
        concurrency_limit INTEGER NOT NULL DEFAULT 5,
        trigger_rate_limit INTEGER NOT NULL DEFAULT 10,
        cooldown_ms INTEGER,
        opened_at INTEGER,
        reason TEXT,
        project_code TEXT,
        target_key TEXT,
        session_id TEXT
      );
      INSERT INTO autonomous_loop_breaker (id) VALUES (1);

      CREATE TABLE autonomous_loop_breaker_events (
        id INTEGER PRIMARY KEY,
        epoch INTEGER NOT NULL,
        kind TEXT NOT NULL,
        run_id TEXT,
        project_code TEXT,
        target_key TEXT,
        session_id TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        notified_at INTEGER
      );
      CREATE INDEX idx_autonomous_loop_breaker_events_window ON autonomous_loop_breaker_events (epoch, kind, created_at);
      CREATE UNIQUE INDEX idx_autonomous_loop_breaker_events_start ON autonomous_loop_breaker_events (run_id) WHERE kind = 'external_start';
      CREATE UNIQUE INDEX idx_autonomous_loop_breaker_events_result ON autonomous_loop_breaker_events (run_id) WHERE kind IN ('failure', 'success') AND run_id IS NOT NULL;
      CREATE INDEX idx_autonomous_loop_breaker_events_alert ON autonomous_loop_breaker_events (id) WHERE kind = 'trip' AND notified_at IS NULL;
    `);
  },
};
