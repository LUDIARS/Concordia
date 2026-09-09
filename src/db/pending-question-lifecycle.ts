import type Database from "better-sqlite3";
import { questionClosureDeadline } from "../inbox/question-retention.js";

interface Candidate {
  id: number;
  status: string | null;
  inactive_at: number;
  close_after: number | null;
  taskflow: number;
}

/** Persists the first retirement deadline, including across session row purges. */
export function reconcilePendingQuestionLifecycle(db: Database.Database, now: number): void {
  db.transaction(() => {
    const rows = db.prepare(`
      SELECT q.id, s.status, q.close_after,
             COALESCE(NULLIF(MAX(COALESCE(s.ended_at, 0),
                       COALESCE((SELECT MAX(e.ts) FROM session_events e
                         WHERE e.session_id = q.session_id AND e.kind IN ('end', 'lost')), 0)), 0),
                      s.last_seen_at, ?) AS inactive_at,
             EXISTS(SELECT 1 FROM delegation_runs r WHERE r.child_session_id = q.session_id) AS taskflow
        FROM discord_pending_questions q LEFT JOIN sessions s ON s.id = q.session_id
       WHERE q.answered_at IS NULL AND q.closed_at IS NULL
         AND (s.id IS NULL OR s.status IN ('ended', 'lost', 'abandoned') OR q.close_after IS NOT NULL)
    `).all(now) as Candidate[];
    const update = db.prepare(`UPDATE discord_pending_questions
      SET close_after = ?, closed_at = ?, close_reason = ?
      WHERE id = ? AND answered_at IS NULL AND closed_at IS NULL`);
    for (const row of rows) {
      const deadline = questionClosureDeadline({
        active: row.status === "active" || row.status === "blocked", taskflow: row.taskflow === 1,
        inactiveAt: Math.min(row.inactive_at, now), deadline: row.close_after,
      });
      const closed = deadline !== null && deadline <= now;
      if (deadline !== row.close_after || closed) {
        update.run(deadline, closed ? now : null, closed ? "session_inactive" : null, row.id);
      }
    }
  })();
}
