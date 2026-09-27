import type Database from "better-sqlite3";
import { MajorInjectHistoryRepo } from "./major-inject-history-repo.js";

export interface MajorInjectOverride {
  target_id: string;
  content: string;
  updated_at: number;
}

/** Only catalog-approved IDs reach this repository. Business validation lives above storage. */
export class MajorInjectRepo {
  readonly history: MajorInjectHistoryRepo;
  constructor(private readonly db: Database.Database) { this.history = new MajorInjectHistoryRepo(db); }

  get(targetId: string): MajorInjectOverride | null {
    return this.db.prepare("SELECT target_id, content, updated_at FROM major_inject_overrides WHERE target_id = ?")
      .get(targetId) as MajorInjectOverride | null ?? null;
  }

  set(targetId: string, content: string): MajorInjectOverride {
    const now = Date.now();
    this.db.prepare(`INSERT INTO major_inject_overrides(target_id, content, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`)
      .run(targetId, content, now);
    return this.get(targetId)!;
  }

  delete(targetId: string): void {
    this.db.prepare("DELETE FROM major_inject_overrides WHERE target_id = ?").run(targetId);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
}
