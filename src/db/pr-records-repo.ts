/**
 * pr_records DB access layer.
 *
 * 各 session が作った PR を 1 本のキューとして蓄積する.
 *  - 第一情報源: /v1/stat の open_prs[] から `upsertFromStat` で派生 UPSERT
 *  - 状態確定:   GitHub reconcile tick が `reconcile` で merged/closed/ci/review を更新
 *
 * UNIQUE(repo_origin, number) で 1 PR = 1 行. state は merged/closed に進んだら
 * stat 由来の再観測 (open) では戻さない (履歴を保護する).
 */

import type Database from "better-sqlite3";

export type PrState = "draft" | "open" | "merged" | "closed";
export type PrCiStatus = "unknown" | "pending" | "success" | "failure";
export type PrReviewState =
  | "none"
  | "needs_review"
  | "reviewing"
  | "approved"
  | "changes_requested";

export interface PrRecordRow {
  id: number;
  repo_origin: string;
  repo_path: string | null;
  number: number;
  title: string;
  url: string | null;
  head_branch: string | null;
  head_sha?: string | null;
  base_branch: string | null;
  state: PrState;
  ci_status: PrCiStatus;
  review_state: PrReviewState;
  author_session_id: string | null;
  persona_id: string | null;
  persona_name: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  note: string | null;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  closed_at: number | null;
}

/** stat 由来の派生 UPSERT 入力 (open な PR の最小情報). */
export interface UpsertFromStatInput {
  repo_origin: string;
  number: number;
  title?: string;
  url?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  base_branch?: string | null;
  repo_path?: string | null;
  author_session_id?: string | null;
  persona_id?: string | null;
  persona_name?: string | null;
}

/** GitHub reconcile からの権威ある状態更新入力. */
export interface ReconcileInput {
  repo_origin: string;
  number: number;
  title?: string;
  url?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  base_branch?: string | null;
  state?: PrState;
  ci_status?: PrCiStatus;
  review_state?: PrReviewState;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  merged_at?: number | null;
  closed_at?: number | null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class PrRecordsRepo {
  constructor(private readonly db: Database.Database) {}

  findByKey(repoOrigin: string, number: number): PrRecordRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM pr_records WHERE repo_origin = ? AND number = ?`)
        .get(repoOrigin, number) as PrRecordRow | undefined) ?? null
    );
  }

  /**
   * stat の open_prs[] から 1 件を UPSERT する.
   * - 新規: state='open' で挿入.
   * - 既存: title/url/branch/author を補完しつつ updated_at を更新.
   *   既に merged/closed に確定した行は state を open に戻さない.
   */
  upsertFromStat(input: UpsertFromStatInput): PrRecordRow {
    const now = nowSec();
    const existing = this.findByKey(input.repo_origin, input.number);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO pr_records
             (repo_origin, repo_path, number, title, url, head_branch, head_sha, base_branch,
              state, ci_status, review_state,
              author_session_id, persona_id, persona_name,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 'unknown', 'needs_review', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.repo_origin,
          input.repo_path ?? null,
          input.number,
          input.title ?? "",
          input.url ?? null,
          input.head_branch ?? null,
          input.head_sha ?? null,
          input.base_branch ?? null,
          input.author_session_id ?? null,
          input.persona_id ?? null,
          input.persona_name ?? null,
          now,
          now,
        );
      return this.findByKey(input.repo_origin, input.number)!;
    }

    // 既存行: 欠けている属性のみ補完 (COALESCE 的). state は触らない.
    this.db
      .prepare(
        `UPDATE pr_records SET
           title = CASE WHEN ? <> '' THEN ? ELSE title END,
           url = COALESCE(?, url),
           head_branch = COALESCE(?, head_branch),
           head_sha = COALESCE(?, head_sha),
           base_branch = COALESCE(?, base_branch),
           repo_path = COALESCE(?, repo_path),
           author_session_id = COALESCE(author_session_id, ?),
           persona_id = COALESCE(persona_id, ?),
           persona_name = COALESCE(persona_name, ?),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title ?? "",
        input.title ?? "",
        input.url ?? null,
        input.head_branch ?? null,
        input.head_sha ?? null,
        input.base_branch ?? null,
        input.repo_path ?? null,
        input.author_session_id ?? null,
        input.persona_id ?? null,
        input.persona_name ?? null,
        now,
        existing.id,
      );
    return this.findByKey(input.repo_origin, input.number)!;
  }

  /**
   * GitHub reconcile による権威ある状態更新. 既存行のみ更新する (新規 insert はしない
   * — キューは「session が報告した PR」 に閉じる. 無関係 PR を gh から取り込まない).
   * @returns 更新したら true, 行が無ければ false.
   */
  reconcile(input: ReconcileInput): boolean {
    const existing = this.findByKey(input.repo_origin, input.number);
    if (!existing) return false;
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        args.push(v);
      }
    };
    set("title", input.title !== undefined && input.title !== "" ? input.title : undefined);
    set("url", input.url);
    set("head_branch", input.head_branch);
    set("head_sha", input.head_sha);
    set("base_branch", input.base_branch);
    set("state", input.state);
    set("ci_status", input.ci_status);
    set("review_state", input.review_state);
    set("additions", input.additions);
    set("deletions", input.deletions);
    set("changed_files", input.changed_files);
    set("merged_at", input.merged_at);
    set("closed_at", input.closed_at);
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    args.push(nowSec());
    args.push(existing.id);
    this.db.prepare(`UPDATE pr_records SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return true;
  }

  /** open / draft の PR を更新時刻降順で返す (キュー本体). */
  listActive(): PrRecordRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pr_records WHERE state IN ('open','draft') ORDER BY updated_at DESC`,
      )
      .all() as PrRecordRow[];
  }

  /** 最近 merged の PR を merged_at 降順で limit 件. */
  listRecentlyMerged(limit = 10): PrRecordRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pr_records WHERE state = 'merged'
         ORDER BY COALESCE(merged_at, updated_at) DESC LIMIT ?`,
      )
      .all(limit) as PrRecordRow[];
  }

  /** 汎用 filter (API 用). */
  list(opts: {
    states?: PrState[];
    repo_origin?: string;
    author_session_id?: string;
    limit?: number;
  } = {}): PrRecordRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.states && opts.states.length > 0) {
      where.push(`state IN (${opts.states.map(() => "?").join(",")})`);
      args.push(...opts.states);
    }
    if (opts.repo_origin) {
      where.push(`repo_origin = ?`);
      args.push(opts.repo_origin);
    }
    if (opts.author_session_id) {
      where.push(`author_session_id = ?`);
      args.push(opts.author_session_id);
    }
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    const sql =
      `SELECT * FROM pr_records${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
      ` ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as PrRecordRow[];
  }

  /** open/draft な行を持つ repo_origin の集合 (reconcile 対象の限定). */
  distinctActiveOrigins(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT repo_origin FROM pr_records WHERE state IN ('open','draft')`,
      )
      .all() as Array<{ repo_origin: string }>;
    return rows.map((r) => r.repo_origin);
  }
}
