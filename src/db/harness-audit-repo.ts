/**
 * ローカルセッションのハーネス強制ゲート 監査ログ repository。
 *
 * 設計の要 (ユーザ確定 2026-06-27): 「ログを残して確認できること」が強制システムの
 * 検証層そのもの。 fail-closed で強制を保証する以上、 その保証が実際に効いたかを後から
 * 裏取りできる証跡が無いと意味がない。 よって全判定 (allow/deny/warn) を 1 行ずつ残す。
 *
 * 子会社の subsidiary_requests を踏襲。 対象が外部依頼ではなく自セッションの操作である点だけ違う。
 *
 * **重要**: 書き込み失敗は握りつぶさない ([[feedback_no_error_swallow]])。 証跡が落ちたら強制の
 * 保証も崩れるため、 record() は失敗時に例外を投げ、 呼び出し側 (gate) が stderr に surface する。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type HarnessAuditEvent = "inject" | "gate" | "block" | "start_prompt" | "override";
export type HarnessAuditDecision = "allow" | "deny" | "warn";

export interface HarnessAuditRow {
  id: string;
  session_id: string;
  project: string;
  hook: string;
  event: HarnessAuditEvent;
  tool: string;
  action: string;
  repo: string;
  rule: string;
  decision: HarnessAuditDecision;
  reason: string;
  detail_json: string;
  ms: number;
  created_at: number;
}

export interface RecordHarnessAuditInput {
  session_id?: string;
  project?: string;
  hook?: string;
  event: HarnessAuditEvent;
  tool?: string;
  action?: string;
  /** 操作対象リポ root (max-repos の editedRepos 集計に使う)。 */
  repo?: string;
  rule?: string;
  decision: HarnessAuditDecision;
  reason?: string;
  detail?: unknown;
  ms?: number;
}

export interface ListHarnessAuditFilter {
  session_id?: string;
  decision?: HarnessAuditDecision;
  event?: HarnessAuditEvent;
  limit?: number;
}

export class HarnessAuditRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * 1 件記録する。 SQLite 書き込みが失敗したら例外を投げる (握りつぶさない)。
   * 監査が落ちることは強制の保証が崩れることなので、 呼び出し側が必ず気づくべき。
   */
  record(input: RecordHarnessAuditInput): HarnessAuditRow {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO harness_session_audit(
        id, session_id, project, hook, event, tool, action, repo, rule,
        decision, reason, detail_json, ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.session_id ?? "",
      input.project ?? "",
      input.hook ?? "",
      input.event,
      input.tool ?? "",
      input.action ?? "",
      input.repo ?? "",
      input.rule ?? "",
      input.decision,
      input.reason ?? "",
      JSON.stringify(input.detail ?? {}),
      input.ms ?? 0,
      Date.now(),
    );
    return this.db.prepare(`SELECT * FROM harness_session_audit WHERE id = ?`).get(id) as HarnessAuditRow;
  }

  /** 新しい順に取得。 session_id / decision / event で絞り込み可。 */
  recent(filter: ListHarnessAuditFilter = {}): HarnessAuditRow[] {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.session_id) { where.push("session_id = ?"); params.push(filter.session_id); }
    if (filter.decision) { where.push("decision = ?"); params.push(filter.decision); }
    if (filter.event) { where.push("event = ?"); params.push(filter.event); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // created_at が同一 ms でも挿入順で決定的に新しい順を返すため rowid を tiebreaker にする。
    return this.db
      .prepare(`SELECT * FROM harness_session_audit ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as HarnessAuditRow[];
  }

  /** decision 別の件数集計 (確認用サマリ)。 */
  summary(sinceMs = 0): { decision: HarnessAuditDecision; count: number }[] {
    return this.db
      .prepare(`SELECT decision, COUNT(*) as count FROM harness_session_audit WHERE created_at >= ? GROUP BY decision`)
      .all(sinceMs) as { decision: HarnessAuditDecision; count: number }[];
  }

  /**
   * 当該セッションでこれまでに編集ツール (Edit/Write/MultiEdit/NotebookEdit) が触った
   * 異なるリポ root の集合。 max-repos 述語へ供給する editedRepos の状態源 (監査ログ = 状態)。
   * session_id が空なら蓄積できないので空配列。
   */
  distinctEditedRepos(session_id: string): string[] {
    if (!session_id) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT repo FROM harness_session_audit
           WHERE session_id = ? AND repo <> ''
             AND tool IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')`,
      )
      .all(session_id) as Array<{ repo: string }>;
    return rows.map((r) => r.repo);
  }
}
