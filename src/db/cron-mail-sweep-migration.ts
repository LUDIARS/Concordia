import type { NumberedMigration } from "./migrator.js";

export const mailSweepMigration: NumberedMigration = {
  version: 159,
  name: "cron-agent-job-evidence",
  source: "cron_mail_sweeps and agent_instruction_requeue_counts (spec/feature/parttimer-agent-dispatch.md) v1",
  up(db) {
    db.exec(`
      CREATE TABLE cron_mail_sweeps (
        dedupe_key TEXT NOT NULL PRIMARY KEY,
        started_at INTEGER NOT NULL,
        result TEXT
      );
      CREATE TABLE agent_instruction_requeue_counts (
        jst_date TEXT NOT NULL PRIMARY KEY,
        count INTEGER NOT NULL
      );
    `);
  },
};
