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
  /** 投稿の描画元データの指紋。 変わったときだけ Discord の投稿を編集する。 */
  content_hash: string | null;
  /** 投稿と一緒に起動したテスト・QA delegation run。 投稿を閉じるとき session も畳む。 */
  qa_run_id: string | null;
}

export interface DiscordTestSurfacesRepo {
  listOpen(): DiscordTestSurfaceRow[];
  create(input: {
    repoOrigin: string;
    prNumber: number;
    headSha: string;
    worktreePath: string | null;
    threadId: string;
    contentHash: string | null;
  }): DiscordTestSurfaceRow;
  /** 編集リフレッシュ後の head/指紋の書き戻し。 行は作り直さない (thread は同じ)。 */
  updateContent(id: number, input: { headSha: string; contentHash: string | null }): void;
  setQaRun(id: number, qaRunId: string): void;
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
           (scope, repo_origin, pr_number, head_sha, worktree_path, thread_id, status, created_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(
        scope,
        input.repoOrigin,
        input.prNumber,
        input.headSha,
        input.worktreePath,
        input.threadId,
        nowSec(),
        input.contentHash,
      );
      return db.prepare("SELECT * FROM discord_test_surfaces WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as DiscordTestSurfaceRow;
    },
    updateContent(id, input) {
      db.prepare(
        `UPDATE discord_test_surfaces
         SET head_sha = ?, content_hash = ?
         WHERE id = ? AND scope = ? AND status = 'open'`,
      ).run(input.headSha, input.contentHash, id, scope);
    },
    setQaRun(id, qaRunId) {
      db.prepare(
        `UPDATE discord_test_surfaces
         SET qa_run_id = ?
         WHERE id = ? AND scope = ?`,
      ).run(qaRunId, id, scope);
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
