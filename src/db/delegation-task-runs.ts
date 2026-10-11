/**
 * 引き継ぎ判定の入力 (delegation/handoff-task.ts) を delegation_runs と sessions から読む。
 * 読むだけで、run の状態は変えない。
 */
import type Database from "better-sqlite3";
import { isRunOver, type HandoffCandidate } from "../delegation/handoff-task.js";

interface Row {
  id: string; args_json: string; spawn_branch: string | null; status: string;
  created_at: number; session_status: string | null;
}

function stringArg(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function listTaskRunsOnBranch(db: Database.Database, branch: string, limit = 50): HandoffCandidate[] {
  const rows = db.prepare(`SELECT r.id, r.args_json, r.spawn_branch, r.status, r.created_at, s.status AS session_status
      FROM delegation_runs r LEFT JOIN sessions s ON s.id = r.child_session_id
     WHERE r.spawn_branch = ? ORDER BY r.created_at DESC LIMIT ?`).all(branch, limit) as Row[];
  return rows.map((row) => {
    let args: unknown = null;
    try { args = JSON.parse(row.args_json); } catch { args = null; }
    return {
      runId: row.id, reference: stringArg(args, "taskflow_reference"), targetRepo: stringArg(args, "target_repo"),
      branch: row.spawn_branch, runStatus: row.status, sessionStatus: row.session_status, createdAt: row.created_at,
    };
  });
}

/**
 * 前の run がもう作業していないか (多対 1 の run 受け入れ判定)。
 * 記録が無い run は封印直後で行がまだ無いだけかもしれないので、作業中として扱い排他を保つ。
 */
export function isDelegationRunOver(db: Database.Database, runId: string): boolean {
  const row = db.prepare(`SELECT r.status, s.status AS session_status FROM delegation_runs r
      LEFT JOIN sessions s ON s.id = r.child_session_id WHERE r.id = ?`).get(runId) as
      { status: string; session_status: string | null } | undefined;
  return row ? isRunOver({ runStatus: row.status, sessionStatus: row.session_status }) : false;
}
