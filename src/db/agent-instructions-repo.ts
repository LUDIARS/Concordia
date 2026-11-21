/**
 * agent_instructions (migration 150) の読み書き。 判定はしない (instruction-policy.ts が持つ)。
 * 状態の更新は「今の status がこれなら」 の条件付き UPDATE にして、 判定と書き込みの間で
 * 他の要求が先に遷移させても上書きしない。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 指令キューの保存
 */

import type Database from "better-sqlite3";
import type { FinalStatus, InstructionStatus } from "../agent-instructions/instruction-policy.js";

export interface AgentInstructionRow {
  id: string;
  agent: string;
  type: string;
  title: string;
  body: string;
  /** JSON 文字列。 */
  params: string;
  status: InstructionStatus;
  created_at: string;
  acked_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  /** JSON 文字列。 */
  result_detail: string | null;
}

export type NewAgentInstruction = Pick<AgentInstructionRow, "id" | "agent" | "type" | "title" | "body" | "params" | "created_at">;

export interface AgentInstructionStore {
  insert(row: NewAgentInstruction): void;
  find(id: string): AgentInstructionRow | null;
  listByStatus(agent: string, status: InstructionStatus, limit: number): AgentInstructionRow[];
  /** pending → acked。 遷移できたら true。 */
  markAcked(id: string, ackedAt: string): boolean;
  /** pending / acked → done / failed。 pending からなら acked_at も同時に入れる。 遷移できたら true。 */
  markFinished(id: string, update: { status: FinalStatus; finishedAt: string; summary: string; detail: string | null }): boolean;
  /** acked_at が cutoff より前の acked を pending に戻す。 戻した件数。 */
  requeueAckedBefore(cutoff: string): number;
  /** finished_at が cutoff より前の done / failed を消す。 消した件数。 */
  purgeFinishedBefore(cutoff: string): number;
}

export class SqliteAgentInstructionStore implements AgentInstructionStore {
  constructor(private readonly db: Database.Database) {}

  insert(row: NewAgentInstruction): void {
    this.db.prepare(`
      INSERT INTO agent_instructions (id, agent, type, title, body, params, status, created_at)
      VALUES (@id, @agent, @type, @title, @body, @params, 'pending', @created_at)
    `).run(row);
  }

  find(id: string): AgentInstructionRow | null {
    const row = this.db.prepare(`SELECT * FROM agent_instructions WHERE id = ?`).get(id) as AgentInstructionRow | undefined;
    return row ?? null;
  }

  listByStatus(agent: string, status: InstructionStatus, limit: number): AgentInstructionRow[] {
    return this.db.prepare(`
      SELECT * FROM agent_instructions
       WHERE agent = ? AND status = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?
    `).all(agent, status, limit) as AgentInstructionRow[];
  }

  markAcked(id: string, ackedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE agent_instructions SET status = 'acked', acked_at = ?
       WHERE id = ? AND status = 'pending'
    `).run(ackedAt, id);
    return result.changes === 1;
  }

  markFinished(id: string, update: { status: FinalStatus; finishedAt: string; summary: string; detail: string | null }): boolean {
    const result = this.db.prepare(`
      UPDATE agent_instructions
         SET status = ?, finished_at = ?, result_summary = ?, result_detail = ?,
             acked_at = COALESCE(acked_at, ?)
       WHERE id = ? AND status IN ('pending', 'acked')
    `).run(update.status, update.finishedAt, update.summary, update.detail, update.finishedAt, id);
    return result.changes === 1;
  }

  requeueAckedBefore(cutoff: string): number {
    const result = this.db.prepare(`
      UPDATE agent_instructions SET status = 'pending', acked_at = NULL
       WHERE status = 'acked' AND acked_at < ?
    `).run(cutoff);
    return Number(result.changes ?? 0);
  }

  purgeFinishedBefore(cutoff: string): number {
    const result = this.db.prepare(`
      DELETE FROM agent_instructions
       WHERE status IN ('done', 'failed') AND finished_at < ?
    `).run(cutoff);
    return Number(result.changes ?? 0);
  }
}
