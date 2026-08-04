import type Database from "better-sqlite3";

export type DiscordTestSurfaceStatus = "open" | "closed";

export interface DiscordTestSurfaceRow {
  id: number;
  scope: string;
  repo_origin: string;
  pr_number: number;
  head_sha: string;
  repo_root_path: string | null;
  head_branch: string | null;
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
  run_state: "candidate" | "testing" | "merged";
  provider: "codex" | "claude";
  model: string;
  effort: "minimal" | "low" | "medium" | "high" | "xhigh";
  session_id: string | null;
  local_pr_id: string | null;
  controls_message_id: string | null;
}

export interface DiscordTestSurfacesRepo {
  listOpen(): DiscordTestSurfaceRow[];
  findOpen(id: number): DiscordTestSurfaceRow | null;
  create(input: {
    repoOrigin: string;
    prNumber: number;
    headSha: string;
    repoRootPath: string;
    headBranch: string;
    worktreePath: string | null;
    threadId: string;
    contentHash: string | null;
  }): DiscordTestSurfaceRow;
  /** 編集リフレッシュ後の head/指紋の書き戻し。 行は作り直さない (thread は同じ)。 */
  updateContent(id: number, input: { headSha: string; contentHash: string | null }): void;
  setQaRun(id: number, qaRunId: string): void;
  close(id: number, reason: string): void;
  updateRunConfig(id: number, config: { provider: "codex" | "claude"; model: string; effort: DiscordTestSurfaceRow["effort"] }): void;
  markTesting(id: number, sessionId: string, worktreePath?: string | null): void;
  setLocalPrId(id: number, localPrId: string): void;
  markMerged(id: number): void;
  setControlsMessageId(id: number, messageId: string): void;
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
    findOpen(id) {
      return (db.prepare(
        `SELECT * FROM discord_test_surfaces WHERE id = ? AND scope = ? AND status = 'open'`,
      ).get(id, scope) as DiscordTestSurfaceRow | undefined) ?? null;
    },
    create(input) {
      const result = db.prepare(
        `INSERT INTO discord_test_surfaces
           (scope, repo_origin, pr_number, head_sha, repo_root_path, head_branch,
            worktree_path, thread_id, status, created_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(
        scope,
        input.repoOrigin,
        input.prNumber,
        input.headSha,
        input.repoRootPath,
        input.headBranch,
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
    updateRunConfig(id, config) {
      db.prepare(
        `UPDATE discord_test_surfaces SET provider = ?, model = ?, effort = ?
         WHERE id = ? AND scope = ? AND status = 'open' AND run_state = 'candidate'`,
      ).run(config.provider, config.model, config.effort, id, scope);
    },
    markTesting(id, sessionId, worktreePath = null) {
      db.prepare(
        `UPDATE discord_test_surfaces
         SET run_state = 'testing', session_id = ?, worktree_path = COALESCE(?, worktree_path)
         WHERE id = ? AND scope = ? AND status = 'open' AND run_state = 'candidate'`,
      ).run(sessionId, worktreePath, id, scope);
    },
    setLocalPrId(id, localPrId) {
      db.prepare(
        `UPDATE discord_test_surfaces SET local_pr_id = ? WHERE id = ? AND scope = ? AND status = 'open'`,
      ).run(localPrId, id, scope);
    },
    markMerged(id) {
      db.prepare(
        `UPDATE discord_test_surfaces SET run_state = 'merged'
         WHERE id = ? AND scope = ? AND status = 'open' AND run_state = 'testing'`,
      ).run(id, scope);
    },
    setControlsMessageId(id, messageId) {
      db.prepare(
        `UPDATE discord_test_surfaces SET controls_message_id = ? WHERE id = ? AND scope = ?`,
      ).run(messageId, id, scope);
    },
  };
}
