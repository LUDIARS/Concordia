/** @implements spec/feature/project-created-notify.md — 控えの永続化 */
import type Database from "better-sqlite3";
import type { ProjectCreatedEvent, ProjectNoticeDelivery, ProjectNoticeLedger } from "./project-created.js";

/**
 * repository を主キーにした at-most-once の控え。
 * arm は登録時、claim は初回 push 時。notified_at が入った行は二度と claim できない。
 */
export class SqliteProjectNoticeLedger implements ProjectNoticeLedger {
  constructor(private readonly db: Database.Database) {}

  arm(event: ProjectCreatedEvent, now: number): boolean {
    return this.db.prepare(
      `INSERT INTO project_notice_ledger(repository, code, project, repo_url, armed_at, notified_at)
       VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(repository) DO NOTHING`,
    ).run(event.repository, event.code, event.project, event.repoUrl, now).changes === 1;
  }

  claim(repository: string, now: number): ProjectCreatedEvent | null {
    const row = this.db.prepare(
      "SELECT repository, code, project, repo_url FROM project_notice_ledger WHERE repository = ? AND notified_at IS NULL",
    ).get(repository) as { repository: string; code: string; project: string; repo_url: string } | undefined;
    if (!row) return null;
    const claimed = this.db.prepare(
      "UPDATE project_notice_ledger SET notified_at = ? WHERE repository = ? AND notified_at IS NULL",
    ).run(now, repository).changes === 1;
    if (!claimed) return null;
    return { repository: row.repository, code: row.code, project: row.project, repoUrl: row.repo_url };
  }
}

/** Bot 送信は runtime 境界に置き、通知方針から切り離す。 */
export function createProjectNoticeDelivery(postCcChannel: (content: string) => Promise<void>): ProjectNoticeDelivery {
  return { ccChannel: postCcChannel };
}
