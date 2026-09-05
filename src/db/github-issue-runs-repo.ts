/**
 * GitHub Issue ワークフローの run 台帳。
 *
 * webhook とポーリングの二重受信、 プロセス再起動を跨いだ追跡、 「どこで止まったか」の
 * 説明責任をこの 1 テーブルで持つ。 状態遷移の判断は github/ 側 (SRP — ここは CRUD)。
 *
 * @implements spec/feature/github-issue-workflow.md — 状態
 */

import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";

/** @implements spec/feature/github-issue-workflow.md — 状態 */
export const GITHUB_ISSUE_RUN_STATUSES = [
  "queued",
  "running",
  "pr_submitted",
  "review_passed",
  "published",
  "skipped",
  "failed",
] as const;

export type GithubIssueRunStatus = (typeof GITHUB_ISSUE_RUN_STATUSES)[number];

/** これ以上進まない状態。 retry だけが次を作れる。 */
export const GITHUB_ISSUE_RUN_TERMINAL: readonly GithubIssueRunStatus[] = [
  "published",
  "skipped",
  "failed",
];

export interface GithubIssueRunRow {
  id: string;
  repo_origin: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  label: string;
  actor: string;
  project_code: string | null;
  repo_path: string;
  branch: string;
  status: GithubIssueRunStatus;
  delegation_run_id: string | null;
  local_pr_id: string | null;
  github_pr_url: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

export interface GithubIssueRunCreate {
  repoOrigin: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  label: string;
  actor: string;
  projectCode: string | null;
  repoPath: string;
  branch: string;
}

export interface GithubIssueRunPatch {
  status?: GithubIssueRunStatus;
  delegationRunId?: string | null;
  localPrId?: string | null;
  githubPrUrl?: string | null;
  detail?: string | null;
}

export interface GithubIssueRunsRepo {
  /** 既に同じ Issue の run があれば作らずに `null` を返す (二重起動しない)。 */
  create(input: GithubIssueRunCreate, now?: number): GithubIssueRunRow | null;
  find(id: string): GithubIssueRunRow | null;
  findByIssue(repoOrigin: string, issueNumber: number, label: string): GithubIssueRunRow | null;
  list(filter?: { statuses?: readonly GithubIssueRunStatus[]; limit?: number }): GithubIssueRunRow[];
  update(id: string, patch: GithubIssueRunPatch, now?: number): GithubIssueRunRow | null;
  /** 終端 run を消して同じ Issue を作り直せるようにする (retry)。 */
  remove(id: string): boolean;
}

export function makeGithubIssueRunsRepo(db: Database): GithubIssueRunsRepo {
  const selectById = db.prepare("SELECT * FROM github_issue_runs WHERE id = ?");
  const selectByIssue = db.prepare(
    `SELECT * FROM github_issue_runs
     WHERE repo_origin = ? COLLATE NOCASE AND issue_number = ? AND label = ?`,
  );

  const find = (id: string): GithubIssueRunRow | null =>
    (selectById.get(id) as GithubIssueRunRow | undefined) ?? null;

  return {
    create(input, now = Date.now()) {
      // 検査と INSERT を 1 transaction に閉じる。 webhook とポーリングが同時に同じ Issue を
      // 見たとき、 別 statement のままだと両方が「未登録」を見て 2 本走る。
      const run = db.transaction((): GithubIssueRunRow | null => {
        const existing = selectByIssue.get(input.repoOrigin, input.issueNumber, input.label) as
          | GithubIssueRunRow
          | undefined;
        if (existing) return null;
        const id = randomUUID();
        db.prepare(`
          INSERT INTO github_issue_runs(
            id, repo_origin, issue_number, issue_title, issue_url, label, actor,
            project_code, repo_path, branch, status, delegation_run_id, local_pr_id,
            github_pr_url, detail, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          id,
          input.repoOrigin,
          input.issueNumber,
          input.issueTitle,
          input.issueUrl,
          input.label,
          input.actor,
          input.projectCode,
          input.repoPath,
          input.branch,
          now,
          now,
        );
        return find(id);
      });
      return run.immediate();
    },

    find,

    findByIssue(repoOrigin, issueNumber, label) {
      return (selectByIssue.get(repoOrigin, issueNumber, label) as GithubIssueRunRow | undefined) ?? null;
    },

    list(filter = {}) {
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1_000);
      if (!filter.statuses || filter.statuses.length === 0) {
        return db.prepare("SELECT * FROM github_issue_runs ORDER BY created_at DESC LIMIT ?")
          .all(limit) as GithubIssueRunRow[];
      }
      const placeholders = filter.statuses.map(() => "?").join(", ");
      return db.prepare(
        `SELECT * FROM github_issue_runs WHERE status IN (${placeholders})
         ORDER BY created_at DESC LIMIT ?`,
      ).all(...filter.statuses, limit) as GithubIssueRunRow[];
    },

    update(id, patch, now = Date.now()) {
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      const push = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.status !== undefined) push("status", patch.status);
      if (patch.delegationRunId !== undefined) push("delegation_run_id", patch.delegationRunId);
      if (patch.localPrId !== undefined) push("local_pr_id", patch.localPrId);
      if (patch.githubPrUrl !== undefined) push("github_pr_url", patch.githubPrUrl);
      if (patch.detail !== undefined) push("detail", patch.detail);
      if (sets.length === 0) return find(id);
      push("updated_at", now);
      const info = db.prepare(`UPDATE github_issue_runs SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values, id);
      return info.changes === 0 ? null : find(id);
    },

    remove(id) {
      return db.prepare("DELETE FROM github_issue_runs WHERE id = ?").run(id).changes > 0;
    },
  };
}

/** webhook の再送を弾く delivery 記録。 新規なら true。 */
export function makeGithubDeliveryLog(db: Database): {
  markProcessed(deliveryId: string, event: string, now?: number): boolean;
  prune(olderThanMs: number, now?: number): number;
} {
  return {
    markProcessed(deliveryId, event, now = Date.now()) {
      const info = db.prepare(
        `INSERT INTO github_event_deliveries(delivery_id, event, received_at)
         VALUES (?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
      ).run(deliveryId, event, now);
      return info.changes > 0;
    },
    prune(olderThanMs, now = Date.now()) {
      return db.prepare("DELETE FROM github_event_deliveries WHERE received_at < ?")
        .run(now - olderThanMs).changes;
    },
  };
}
