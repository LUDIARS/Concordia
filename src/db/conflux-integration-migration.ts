import type { NumberedMigration } from "./migrator.js";

export const confluxIntegrationMigration: NumberedMigration = {
  version: 152,
  name: "conflux-integration",
  source: "conflux integration receipts, build queue and hook outbox (CC-CF-INTEGRATION) v1",
  up(db) {
    db.exec(`
      CREATE TABLE conflux_spawn_receipts (
        key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        enrollment_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('launching', 'failed', 'uncertain')),
        session_id TEXT
      );
      CREATE TABLE conflux_build_jobs (
        key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        request TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX conflux_build_queue ON conflux_build_jobs(state, queued_at, key);
      CREATE TABLE conflux_hook_outbox (
        key TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0,
        delivered_at INTEGER
      );
      CREATE INDEX conflux_hook_pending ON conflux_hook_outbox(delivered_at, next_attempt);
    `);
  },
};
