import type { NumberedMigration } from "./migrator.js";

export const gen5MergeReturnMigration: NumberedMigration = {
  version: 153,
  name: "gen5-merge-return",
  source: "merge playtest return history and external bridge delivery evidence v1",
  up(db) {
    db.exec(`
      ALTER TABLE conflux_hook_outbox ADD COLUMN last_failure_at INTEGER;
      ALTER TABLE conflux_hook_outbox ADD COLUMN last_failure_reason TEXT;
      UPDATE conflux_hook_outbox SET
        last_failure_at = next_attempt - MIN(60000 * (1 << MIN(attempts - 1, 6)), 3600000),
        last_failure_reason = 'prior_delivery_failure'
        WHERE attempts > 0 AND next_attempt > 0;
      CREATE INDEX conflux_hook_last_failure ON conflux_hook_outbox(last_failure_at DESC);

      CREATE TABLE playtest_delivery_evidence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_success_at TEXT,
        last_failure_at TEXT,
        last_failure_reason TEXT
      );
      INSERT INTO playtest_delivery_evidence (id) VALUES (1);

      CREATE TABLE merge_playtest_returns (
        id INTEGER PRIMARY KEY,
        project_code TEXT NOT NULL,
        merge_commit_sha TEXT NOT NULL,
        branch TEXT NOT NULL,
        observation_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'disabled', 'duplicate', 'breaker_open', 'build_rejected')),
        reason TEXT,
        build_key TEXT,
        instruction_id TEXT,
        observed_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX merge_playtest_return_queued
        ON merge_playtest_returns(project_code, merge_commit_sha) WHERE status = 'queued';
      CREATE TABLE merge_playtest_return_projects (
        project_code TEXT PRIMARY KEY,
        enabled_at INTEGER NOT NULL
      );
    `);
  },
};
