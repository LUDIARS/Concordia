/**
 * 進捗ボード (control_progress_board) の読み書き。セッションごとに最新 1 行を上書きする。
 *
 * @implements spec/feature/control-session.md — 2. 進捗ボード / CC-CTL-INV-02 / CC-CTL-INV-04
 */
import type Database from "better-sqlite3";

export interface ControlBoardEntry {
  session_id: string;
  project: string;
  branch: string | null;
  /** 自動確認が記録した作業状態 (task-active 等)。記録が無ければ null。 */
  followup_state: string | null;
  /** 自動確認の作業状態の指紋。記録が無ければ null。 */
  fingerprint: string | null;
  /** 自動確認で作業状態が変わらなかった連続回数。 */
  unchanged_count: number;
  current_task: string | null;
  /** サイドチャンネル (stat-collect) の最新の現況の要約。 */
  side_summary: string | null;
  side_reported_at: number | null;
  last_activity_at: number | null;
  updated_at: number;
}

export interface ControlBoardRow extends ControlBoardEntry {
  /** 管制セッションへ停止を伝えた指紋。同じ指紋は再送しない。 */
  digested_fingerprint: string | null;
}

export class ControlBoardRepo {
  constructor(private readonly db: Database.Database) {}

  /** 1 行を上書きする。停止を伝えた記録 (digested_fingerprint) は保つ。 */
  upsert(entry: ControlBoardEntry): void {
    this.db.prepare(`
      INSERT INTO control_progress_board (
        session_id, project, branch, followup_state, fingerprint, unchanged_count, current_task,
        side_summary, side_reported_at, last_activity_at, updated_at, digested_fingerprint
      ) VALUES (
        @session_id, @project, @branch, @followup_state, @fingerprint, @unchanged_count, @current_task,
        @side_summary, @side_reported_at, @last_activity_at, @updated_at, NULL
      )
      ON CONFLICT(session_id) DO UPDATE SET
        project = excluded.project, branch = excluded.branch, followup_state = excluded.followup_state,
        fingerprint = excluded.fingerprint, unchanged_count = excluded.unchanged_count,
        current_task = excluded.current_task, side_summary = excluded.side_summary,
        side_reported_at = excluded.side_reported_at, last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at
    `).run(entry);
  }

  list(): ControlBoardRow[] {
    return this.db.prepare(`SELECT * FROM control_progress_board ORDER BY project, session_id`).all() as ControlBoardRow[];
  }

  find(sessionId: string): ControlBoardRow | null {
    return (this.db.prepare(`SELECT * FROM control_progress_board WHERE session_id = ?`).get(sessionId) as ControlBoardRow | undefined) ?? null;
  }

  /** 指定以外の行 (終了したセッション) を消す。 */
  retainOnly(sessionIds: readonly string[]): number {
    const rows = this.db.prepare(`SELECT session_id FROM control_progress_board`).all() as Array<{ session_id: string }>;
    const keep = new Set(sessionIds);
    const del = this.db.prepare(`DELETE FROM control_progress_board WHERE session_id = ?`);
    let removed = 0;
    for (const row of rows) {
      if (keep.has(row.session_id)) continue;
      removed += del.run(row.session_id).changes;
    }
    return removed;
  }

  markDigested(sessionId: string, fingerprint: string): void {
    this.db.prepare(`UPDATE control_progress_board SET digested_fingerprint = ? WHERE session_id = ?`).run(fingerprint, sessionId);
  }

  clear(): void {
    this.db.prepare(`DELETE FROM control_progress_board`).run();
  }
}
