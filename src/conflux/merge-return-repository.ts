import type { Database } from "better-sqlite3";
import type { MergeReturnTarget, MergeReturnDecision } from "./merge-return-policy.js";

export type MergeReturnStatus = MergeReturnDecision | "build_rejected";
export interface MergeReturnRecord extends MergeReturnTarget {
  observation_key: string;
  status: MergeReturnStatus;
  reason: string | null;
  build_key: string | null;
  instruction_id: string | null;
  observed_at: number;
}

export class MergeReturnRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  find(observationKey: string): MergeReturnRecord | undefined {
    return this.db.prepare("SELECT * FROM merge_playtest_returns WHERE observation_key = ?").get(observationKey) as MergeReturnRecord | undefined;
  }

  syncEnabledProjects(codes: readonly string[], now: number): Map<string, number> {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT project_code, enabled_at FROM merge_playtest_return_projects")
        .all() as { project_code: string; enabled_at: number }[];
      const enabled = new Map(rows.map(({ project_code, enabled_at }) => [project_code, enabled_at]));
      const desired = new Set(codes);
      for (const code of enabled.keys()) {
        if (desired.has(code)) continue;
        this.db.prepare("DELETE FROM merge_playtest_return_projects WHERE project_code = ?").run(code);
        enabled.delete(code);
      }
      for (const code of desired) {
        if (enabled.has(code)) continue;
        this.db.prepare("INSERT INTO merge_playtest_return_projects VALUES (?, ?)").run(code, now);
        enabled.set(code, now);
      }
      return enabled;
    });
  }

  wasQueued(target: MergeReturnTarget): boolean {
    return this.db.prepare(`SELECT 1 FROM merge_playtest_returns
      WHERE project_code = ? AND merge_commit_sha = ? AND status = 'queued'`).get(target.project_code, target.merge_commit_sha) !== undefined;
  }

  insert(record: MergeReturnRecord): void {
    this.db.prepare(`INSERT INTO merge_playtest_returns
      (project_code, merge_commit_sha, branch, observation_key, status, reason, build_key, instruction_id, observed_at)
      VALUES (@project_code, @merge_commit_sha, @branch, @observation_key, @status, @reason, @build_key, @instruction_id, @observed_at)`).run(record);
  }

  recent(): MergeReturnRecord[] {
    return this.db.prepare("SELECT * FROM merge_playtest_returns ORDER BY id DESC LIMIT 100").all() as MergeReturnRecord[];
  }
}
