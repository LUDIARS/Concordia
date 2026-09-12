import type Database from "better-sqlite3";
import type { ReleaseNoticeDelivery, ReleaseNoticeLedger } from "./release-published.js";

/** Durable at-most-once claim for a Revisor release event. */
export class SqliteReleaseNoticeLedger implements ReleaseNoticeLedger {
  constructor(private readonly db: Database.Database) {}

  claim(repository: string, tag: string): boolean {
    return this.db.prepare(
      "INSERT INTO release_notice_ledger(repository, tag, received_at) VALUES (?, ?, ?) ON CONFLICT(repository, tag) DO NOTHING",
    ).run(repository, tag, Date.now()).changes === 1;
  }
}

/** Keeps the Bot transport at the runtime boundary, separate from release policy. */
export function createReleaseNoticeDelivery(postCcChannel: (content: string) => Promise<void>): ReleaseNoticeDelivery {
  return { ccChannel: postCcChannel };
}
