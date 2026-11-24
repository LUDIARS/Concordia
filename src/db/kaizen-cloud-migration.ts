import type { NumberedMigration } from "./migrator.js";

export const kaizenCloudMigration: NumberedMigration = {
  version: 160,
  name: "kaizen-cloud-dispatch",
  source: "kaizen_cloud_results and kaizen_cloud_attempts v1",
  up(db) {
    db.exec(`
      CREATE TABLE kaizen_cloud_results (
        instruction_id TEXT PRIMARY KEY,
        started_at INTEGER,
        report TEXT,
        posted_at INTEGER
      );
      CREATE TABLE kaizen_cloud_attempts (
        id TEXT PRIMARY KEY,
        repository_key TEXT NOT NULL,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        task_reference TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX kaizen_cloud_attempts_pending ON kaizen_cloud_attempts(finished_at, expires_at);
    `);
  },
};
