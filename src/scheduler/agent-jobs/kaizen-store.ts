import type Database from "better-sqlite3";

export interface KaizenResult {
  id: string;
  started_at: number | null;
  report: string | null;
}

export interface KaizenAttempt {
  id: string;
  repository_key: string;
  project: string;
  title: string;
  task_reference: string;
  expires_at: number;
}

/** Tracks trusted cron registrations, result application and Git return work. */
export function createKaizenStore(db: Database.Database) {
  return {
    register<T extends { id: string; kind: string }>(register: () => T): T {
      return db.transaction(() => {
        const instruction = register();
        if (instruction.kind === "registered") {
          db.prepare("INSERT INTO kaizen_cloud_results (instruction_id) VALUES (?)").run(instruction.id);
        }
        return instruction;
      })();
    },
    tracked(id: string): boolean {
      return !!db.prepare("SELECT 1 FROM kaizen_cloud_results WHERE instruction_id = ?").get(id);
    },
    ready(): KaizenResult[] {
      return db.prepare(`SELECT i.id, k.started_at, k.report FROM kaizen_cloud_results k
        JOIN agent_instructions i ON i.id = k.instruction_id
        WHERE i.status = 'done' AND k.posted_at IS NULL ORDER BY i.finished_at LIMIT 20`).all() as KaizenResult[];
    },
    claim(id: string, now: number): boolean {
      return db.prepare("UPDATE kaizen_cloud_results SET started_at = ? WHERE instruction_id = ? AND started_at IS NULL")
        .run(now, id).changes === 1;
    },
    recordReport(id: string, report: string): void {
      db.prepare("UPDATE kaizen_cloud_results SET report = ? WHERE instruction_id = ? AND report IS NULL").run(report, id);
    },
    markPosted(id: string, now: number): void {
      db.prepare("UPDATE kaizen_cloud_results SET posted_at = ? WHERE instruction_id = ?").run(now, id);
    },
    reserveAttempt(attempt: KaizenAttempt): void {
      db.prepare(`INSERT INTO kaizen_cloud_attempts (id, repository_key, project, title, task_reference, expires_at)
        VALUES (@id, @repository_key, @project, @title, @task_reference, @expires_at)`).run(attempt);
    },
    pendingAttempts(): KaizenAttempt[] {
      return db.prepare(`SELECT id, repository_key, project, title, task_reference, expires_at
        FROM kaizen_cloud_attempts WHERE finished_at IS NULL ORDER BY expires_at`).all() as KaizenAttempt[];
    },
    finishAttempt(id: string, now: number): void {
      db.prepare("UPDATE kaizen_cloud_attempts SET finished_at = ? WHERE id = ?").run(now, id);
    },
    prune(before: number): void {
      db.prepare(`DELETE FROM kaizen_cloud_results WHERE NOT EXISTS
        (SELECT 1 FROM agent_instructions WHERE id = kaizen_cloud_results.instruction_id)`).run();
      db.prepare("DELETE FROM kaizen_cloud_attempts WHERE finished_at < ?").run(before);
    },
  };
}

export type KaizenStore = ReturnType<typeof createKaizenStore>;
