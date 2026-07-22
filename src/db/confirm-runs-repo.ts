/**
 * 確認 (develop に入った変更をユーザが動作確認する) の台帳。
 *
 * spec/feature/develop-confirm-flow.md §4 が schema の正本。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type ConfirmStatus = "pending" | "confirming" | "confirmed" | "rejected" | "failed";

/** 確認待ち / 確認中 (= まだ決着していない) 状態。 */
export const OPEN_CONFIRM_STATUSES: readonly ConfirmStatus[] = ["pending", "confirming"];

export interface ConfirmRunRow {
  id: string;
  repo_origin: string;
  repo_name: string;
  service_code: string | null;
  pr_number: number;
  pr_title: string;
  pr_url: string | null;
  develop_sha: string | null;
  start_approved_by: string | null;
  promotion_approved_by: string | null;
  status: ConfirmStatus;
  memoria_task_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateConfirmRunInput {
  repo_origin: string;
  repo_name: string;
  service_code?: string | null;
  pr_number: number;
  pr_title?: string;
  pr_url?: string | null;
  develop_sha?: string | null;
}

export class ConfirmRunsRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * PR 1 件ぶんの確認を作る。 既にあれば作らず既存を返す (reconcile は同じ merge を
   * 何度も観測するので冪等性が要る)。
   */
  createIfAbsent(input: CreateConfirmRunInput): { row: ConfirmRunRow; created: boolean } {
    const existing = this.findByPr(input.repo_origin, input.pr_number);
    if (existing) return { row: existing, created: false };

    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO confirm_runs(
        id, repo_origin, repo_name, service_code, pr_number, pr_title, pr_url,
        develop_sha, status, memoria_task_id, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
    `).run(
      id,
      input.repo_origin,
      input.repo_name,
      input.service_code ?? null,
      input.pr_number,
      input.pr_title ?? "",
      input.pr_url ?? null,
      input.develop_sha ?? null,
      now,
      now,
    );
    return { row: this.find(id)!, created: true };
  }

  find(id: string): ConfirmRunRow | null {
    return (this.db.prepare(`SELECT * FROM confirm_runs WHERE id = ?`).get(id) as ConfirmRunRow | undefined) ?? null;
  }

  findByPr(repoOrigin: string, prNumber: number): ConfirmRunRow | null {
    return (this.db
      .prepare(`SELECT * FROM confirm_runs WHERE repo_origin = ? AND pr_number = ?`)
      .get(repoOrigin, prNumber) as ConfirmRunRow | undefined) ?? null;
  }

  /** 未決着 (pending / confirming) の確認を古い順に返す。 */
  listOpen(): ConfirmRunRow[] {
    return this.db.prepare(
      `SELECT * FROM confirm_runs WHERE status IN ('pending', 'confirming') ORDER BY created_at ASC`,
    ).all() as ConfirmRunRow[];
  }

  /**
   * あるサービスの未決着の確認。 連続でマージすると 1 サービスに複数溜まるが、 develop HEAD には
   * 全部入っているので確認は 1 回で足りる (start/ok はまとめて状態遷移させる)。
   */
  listOpenForService(serviceCode: string): ConfirmRunRow[] {
    return this.db.prepare(
      `SELECT * FROM confirm_runs
        WHERE service_code = ? AND status IN ('pending', 'confirming')
        ORDER BY created_at ASC`,
    ).all(serviceCode) as ConfirmRunRow[];
  }

  listRecent(limit = 100): ConfirmRunRow[] {
    return this.db.prepare(
      `SELECT * FROM confirm_runs ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as ConfirmRunRow[];
  }

  setStatus(id: string, status: ConfirmStatus, error?: string | null): ConfirmRunRow | null {
    const row = this.find(id);
    if (!row) return null;
    this.db.prepare(
      `UPDATE confirm_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
    ).run(status, error !== undefined ? error : row.error, Date.now(), id);
    return this.find(id);
  }

  setMemoriaTaskId(id: string, taskId: number | null): void {
    this.db.prepare(
      `UPDATE confirm_runs SET memoria_task_id = ?, updated_at = ? WHERE id = ?`,
    ).run(taskId, Date.now(), id);
  }

  setDevelopSha(id: string, sha: string | null): void {
    this.db.prepare(
      `UPDATE confirm_runs SET develop_sha = ?, updated_at = ? WHERE id = ?`,
    ).run(sha, Date.now(), id);
  }

  setStartApproval(id: string, principalId: string): void {
    this.db.prepare(
      `UPDATE confirm_runs
          SET start_approved_by = ?, promotion_approved_by = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(principalId, Date.now(), id);
  }

  setPromotionApproval(id: string, principalId: string): void {
    this.db.prepare(
      `UPDATE confirm_runs SET promotion_approved_by = ?, updated_at = ? WHERE id = ?`,
    ).run(principalId, Date.now(), id);
  }
}
