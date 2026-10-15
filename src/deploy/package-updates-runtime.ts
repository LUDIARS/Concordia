import type Database from "better-sqlite3";
import type { PackageUpdateLedger } from "./package-updates.js";

/** Durable (run_id, message_index) claim for package update notices. */
export class SqlitePackageUpdateLedger implements PackageUpdateLedger {
  constructor(private readonly db: Database.Database) {}

  claim(runId: string, index: number): boolean {
    return this.db.prepare(
      "INSERT INTO package_update_ledger(run_id, message_index, received_at) VALUES (?, ?, ?) ON CONFLICT(run_id, message_index) DO NOTHING",
    ).run(runId, index, Date.now()).changes === 1;
  }

  release(runId: string, index: number): void {
    this.db.prepare("DELETE FROM package_update_ledger WHERE run_id = ? AND message_index = ?").run(runId, index);
  }
}
