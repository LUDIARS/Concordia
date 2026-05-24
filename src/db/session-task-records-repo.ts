/**
 * session_task_records — per-session persistence of TodoWrite items.
 *
 * Each entry in a `task_update` event payload (`.todos[]`) is upserted by
 * (session_id, task_text). Status transitions are tracked, and the moment
 * a task first becomes `completed` we freeze `completed_at` + `handled_by_session`
 * so subsequent edits (e.g. the user re-opens the task) don't erase the
 * fact that some session actually completed it. This means at session-end
 * the rows with `status != 'completed'` are the **remaining tasks**.
 */

import type Database from "better-sqlite3";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface SessionTaskRecord {
  id: number;
  session_id: string;
  task_text: string;
  active_form: string | null;
  status: TaskStatus;
  first_seen_at: number;
  last_updated_at: number;
  completed_at: number | null;
  handled_by_session: string | null;
}

export interface IncomingTodo {
  /** Claude Code TodoWrite uses `content` for the imperative form. */
  content?: unknown;
  /** activeForm = the "I am doing X" form, used when status=in_progress. */
  activeForm?: unknown;
  status?: unknown;
}

export class SessionTaskRecordsRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Apply one `task_update` event payload (`.todos[]`) for the given session.
   * Returns counts so callers can log / log-test without doing a second scan.
   *
   * Behaviour per todo entry:
   *   - new (session_id, task_text)  → INSERT with first_seen_at = nowSec
   *   - existing, status unchanged    → bump last_updated_at + active_form
   *   - existing, status moves        → bump status. On first transition to
   *                                     'completed', set completed_at = nowSec
   *                                     and handled_by_session = the session
   *                                     reporting it. Subsequent transitions
   *                                     (e.g. completed → pending) DO update
   *                                     status but DO NOT clear completed_at
   *                                     so completion history survives churn.
   */
  applyTaskUpdate(opts: {
    session_id: string;
    todos: IncomingTodo[];
    nowSec: number;
  }): { upserted: number; completed_new: number } {
    const todos = Array.isArray(opts.todos) ? opts.todos : [];
    let upserted = 0;
    let completedNew = 0;

    const findStmt = this.db.prepare(
      `SELECT id, status, completed_at FROM session_task_records WHERE session_id = ? AND task_text = ?`,
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO session_task_records
         (session_id, task_text, active_form, status, first_seen_at, last_updated_at, completed_at, handled_by_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateStmt = this.db.prepare(
      `UPDATE session_task_records
         SET active_form = ?,
             status = ?,
             last_updated_at = ?,
             completed_at = COALESCE(completed_at, ?),
             handled_by_session = COALESCE(handled_by_session, ?)
       WHERE id = ?`,
    );

    const tx = this.db.transaction(() => {
      for (const todo of todos) {
        const text = normalizeText(todo.content);
        if (!text) continue;
        const status = normalizeStatus(todo.status);
        const activeForm = normalizeText(todo.activeForm);
        const existing = findStmt.get(opts.session_id, text) as
          | { id: number; status: TaskStatus; completed_at: number | null }
          | undefined;
        const becomingCompleted =
          status === "completed" && (!existing || existing.completed_at === null);

        if (existing) {
          updateStmt.run(
            activeForm,
            status,
            opts.nowSec,
            becomingCompleted ? opts.nowSec : null,
            becomingCompleted ? opts.session_id : null,
            existing.id,
          );
        } else {
          insertStmt.run(
            opts.session_id,
            text,
            activeForm,
            status,
            opts.nowSec,
            opts.nowSec,
            becomingCompleted ? opts.nowSec : null,
            becomingCompleted ? opts.session_id : null,
          );
        }
        upserted++;
        if (becomingCompleted) completedNew++;
      }
    });
    tx();

    return { upserted, completed_new: completedNew };
  }

  listBySession(session_id: string): SessionTaskRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM session_task_records
         WHERE session_id = ?
         ORDER BY first_seen_at ASC, id ASC`,
      )
      .all(session_id) as SessionTaskRecord[];
  }

  /**
   * Cross-session "what's still open" — useful for picking up unfinished
   * work from prior sessions. Returns rows with status != 'completed',
   * newest-touched first, with an optional repo_path filter (matched via
   * a JOIN on sessions.repo_path / repo_origin).
   */
  listRemaining(opts: {
    repo_path?: string;
    limit?: number;
  } = {}): Array<SessionTaskRecord & { repo_path: string | null }> {
    const limit = opts.limit ?? 200;
    const params: unknown[] = [];
    let sql =
      `SELECT r.*, s.repo_path AS repo_path
         FROM session_task_records r
         LEFT JOIN sessions s ON s.id = r.session_id
         WHERE r.status != 'completed'`;
    if (opts.repo_path) {
      sql += ` AND (s.repo_path = ? OR s.repo_origin = ?)`;
      params.push(opts.repo_path, opts.repo_path);
    }
    sql += ` ORDER BY r.last_updated_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as Array<
      SessionTaskRecord & { repo_path: string | null }
    >;
  }

  countBySessionStatus(session_id: string): Record<TaskStatus, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM session_task_records
         WHERE session_id = ? GROUP BY status`,
      )
      .all(session_id) as Array<{ status: TaskStatus; n: number }>;
    const out: Record<TaskStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}

function normalizeText(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t === "" ? null : t.slice(0, 1000);
}

function normalizeStatus(x: unknown): TaskStatus {
  if (x === "completed") return "completed";
  if (x === "in_progress") return "in_progress";
  return "pending";
}
