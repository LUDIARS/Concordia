import type Database from "better-sqlite3";

export type DiscordTestSurfaceStatus = "open" | "closed";

export interface DiscordTestSurfaceRow {
  id: number;
  scope: string;
  repo_origin: string;
  pr_number: number;
  head_sha: string;
  worktree_path: string | null;
  thread_id: string;
  status: DiscordTestSurfaceStatus;
  created_at: number;
  closed_at: number | null;
  close_reason: string | null;
}

export interface DiscordTestSurfacesRepo {
  listOpen(): DiscordTestSurfaceRow[];
  create(input: {
    repoOrigin: string;
    prNumber: number;
    headSha: string;
    worktreePath: string | null;
    threadId: string;
  }): DiscordTestSurfaceRow;
  close(id: number, reason: string): void;
}

export function makeDiscordTestSurfacesRepo(
  db: Database.Database,
  scope = "",
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): DiscordTestSurfacesRepo {
  return {
    listOpen() {
      return db.prepare(
        `SELECT * FROM discord_test_surfaces
         WHERE scope = ? AND status = 'open'
         ORDER BY created_at, id`,
      ).all(scope) as DiscordTestSurfaceRow[];
    },
    create(input) {
      const result = db.prepare(
        `INSERT INTO discord_test_surfaces
           (scope, repo_origin, pr_number, head_sha, worktree_path, thread_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).run(
        scope,
        input.repoOrigin,
        input.prNumber,
        input.headSha,
        input.worktreePath,
        input.threadId,
        nowSec(),
      );
      return db.prepare("SELECT * FROM discord_test_surfaces WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as DiscordTestSurfaceRow;
    },
    close(id, reason) {
      db.prepare(
        `UPDATE discord_test_surfaces
         SET status = 'closed', closed_at = ?, close_reason = ?
         WHERE id = ? AND scope = ? AND status = 'open'`,
      ).run(nowSec(), reason, id, scope);
    },
  };
}
