import type Database from "better-sqlite3";

export interface PendingPlan {
  id: string;
  caseId: string;
  sessionId: string | null;
  title: string;
  version: number;
  raisedAt: number;
}

/** Read only Director's latest unanswered plan; blocked alone does not mean unanswered. */
export function pendingPlans(db: Database.Database, sessionId?: string): PendingPlan[] {
  return db.prepare(`
    SELECT d.id, d.case_id AS caseId, c.session_id AS sessionId, c.title,
           d.plan_version AS version, d.created_at AS raisedAt
      FROM director_decisions d
      JOIN director_steps s ON s.id = d.step_id AND s.case_id = d.case_id
      JOIN director_cases c ON c.id = d.case_id
      LEFT JOIN sessions se ON se.id = c.session_id
     WHERE d.plan_version IS NOT NULL AND d.decision = 'ask_human'
       AND d.human_answered_at IS NULL AND s.kind = 'plan' AND s.status = 'blocked'
       AND (c.session_id IS NULL OR se.status = 'active')
       AND (? IS NULL OR c.session_id = ?)
       AND NOT EXISTS (SELECT 1 FROM director_decisions newer
         WHERE newer.case_id = d.case_id AND newer.step_id = d.step_id
           AND newer.plan_version > d.plan_version)
     ORDER BY d.created_at, d.id
  `).all(sessionId ?? null, sessionId ?? null) as PendingPlan[];
}
