import type Database from "better-sqlite3";
import type { MailSweepData } from "../agent-jobs/quaestor-mail-sweep-data.js";
import type { MailSweepStore } from "./mail-sweep-execution.js";

export function createMailSweepStore(db: Database.Database): MailSweepStore {
  const reserve = db.prepare("INSERT INTO cron_mail_sweeps (dedupe_key, started_at) VALUES (?, ?) ON CONFLICT DO NOTHING");
  const read = db.prepare("SELECT started_at, result FROM cron_mail_sweeps WHERE dedupe_key = ?");
  const finish = db.prepare("UPDATE cron_mail_sweeps SET result = ? WHERE dedupe_key = ? AND result IS NULL");
  return {
    reserve: (key, startedAt) => reserve.run(key, startedAt).changes === 1,
    read: (key) => {
      const row = read.get(key) as { started_at: number; result: string | null } | undefined;
      return row ? { startedAt: row.started_at, result: row.result === null ? null : JSON.parse(row.result) as MailSweepData } : null;
    },
    finish: (key, result) => finish.run(JSON.stringify(result), key).changes === 1,
  };
}
