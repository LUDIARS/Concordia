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

export type RequeuedInstruction = Pick<AgentInstructionRow, "id" | "agent" | "title">;

export interface AgentInstructionStore {
  insert(row: NewAgentInstruction): void;
  find(id: string): AgentInstructionRow | null;
  listByStatus(agent: string, status: InstructionStatus, limit: number): AgentInstructionRow[];
  /** pending → acked。 遷移できたら true。 */
  markAcked(id: string, ackedAt: string): boolean;
  /** pending / acked → done / failed。 pending からなら acked_at も同時に入れる。 遷移できたら true。 */
  markFinished(id: string, update: { status: FinalStatus; finishedAt: string; summary: string; detail: string | null }): boolean;
  /** 新しい順の一覧 (人が見る用)。 agent / status は省略で全部。 */
  listRecent(filter: { agent?: string | undefined; status?: InstructionStatus | undefined; limit: number }): AgentInstructionRow[];
  /** acked_at が cutoff より前の acked を pending に戻す。 戻した指令。 */
  requeueAckedBefore(cutoff: string): RequeuedInstruction[];
  /** finished_at が cutoff より前の done / failed を消す。 消した件数。 */
  purgeFinishedBefore(cutoff: string): number;
  /** params.dedupe_key が一致する指令 (cron 由来の二重登録防止、spec/feature/parttimer-agent-dispatch.md)。 */
  findByDedupeKey(key: string): AgentInstructionRow | null;
  /** params.dedupe_key が prefix で始まり、 created_at が cutoff より前の pending。 古い順。 */
  listPendingWithDedupePrefixBefore(prefix: string, cutoff: string): AgentInstructionRow[];
  /** pending → failed (Cc が期限切れで閉じる)。 acked 以降は触らない。 遷移できたら true。 */
  markExpired(id: string, update: { finishedAt: string; summary: string; detail: string | null }): boolean;
  /** params.job が一致する done のうち最新の要約。 */
  lastDoneSummaryForJob(job: string): string | null;
}

export class SqliteAgentInstructionStore implements AgentInstructionStore {
  constructor(private readonly db: Database.Database) {}

  evidence(agent: string): { last_success_at: string | null; last_failure_at: string | null;
    last_failure_reason: string | null; pending: number; running: number } {
    const counts = this.db.prepare(`SELECT
      COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'acked' THEN 1 END) AS running,
      MAX(CASE WHEN status = 'done' THEN finished_at END) AS last_success_at
      FROM agent_instructions WHERE agent = ?`).get(agent) as { pending: number; running: number; last_success_at: string | null };
    const failed = this.db.prepare(`SELECT finished_at, result_summary FROM agent_instructions
      WHERE agent = ? AND status = 'failed' ORDER BY finished_at DESC, id DESC LIMIT 1`)
      .get(agent) as { finished_at: string; result_summary: string | null } | undefined;
    return { ...counts, last_failure_at: failed?.finished_at ?? null, last_failure_reason: failed?.result_summary ?? null };
  }

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

  listRecent(filter: { agent?: string | undefined; status?: InstructionStatus | undefined; limit: number }): AgentInstructionRow[] {
    return this.db.prepare(`
      SELECT * FROM agent_instructions
       WHERE (@agent IS NULL OR agent = @agent) AND (@status IS NULL OR status = @status)
       ORDER BY created_at DESC, id DESC
       LIMIT @limit
    `).all({ agent: filter.agent ?? null, status: filter.status ?? null, limit: filter.limit }) as AgentInstructionRow[];
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

  requeueAckedBefore(cutoff: string): RequeuedInstruction[] {
    return this.db.prepare(`
      UPDATE agent_instructions SET status = 'pending', acked_at = NULL
       WHERE status = 'acked' AND acked_at < ?
       RETURNING id, agent, title
    `).all(cutoff) as RequeuedInstruction[];
  }

  findByDedupeKey(key: string): AgentInstructionRow | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_instructions
       WHERE json_valid(params) AND json_extract(params, '$.dedupe_key') = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1
    `).get(key) as AgentInstructionRow | undefined;
    return row ?? null;
  }

  listPendingWithDedupePrefixBefore(prefix: string, cutoff: string): AgentInstructionRow[] {
    return this.db.prepare(`
      SELECT * FROM agent_instructions
       WHERE status = 'pending' AND created_at < ?
         AND json_valid(params) AND substr(COALESCE(json_extract(params, '$.dedupe_key'), ''), 1, ?) = ?
       ORDER BY created_at ASC, id ASC
    `).all(cutoff, prefix.length, prefix) as AgentInstructionRow[];
  }

  markExpired(id: string, update: { finishedAt: string; summary: string; detail: string | null }): boolean {
    // acked_at は入れない (受け取られなかった事実を残す)。 acked 以降は外部エージェントが持っているので触らない。
    const result = this.db.prepare(`
      UPDATE agent_instructions
         SET status = 'failed', finished_at = ?, result_summary = ?, result_detail = ?
       WHERE id = ? AND status = 'pending'
    `).run(update.finishedAt, update.summary, update.detail, id);
    return result.changes === 1;
  }

  lastDoneSummaryForJob(job: string): string | null {
    const row = this.db.prepare(`
      SELECT result_summary FROM agent_instructions
       WHERE status = 'done' AND json_valid(params) AND json_extract(params, '$.job') = ?
       ORDER BY finished_at DESC, id DESC
       LIMIT 1
    `).get(job) as { result_summary: string | null } | undefined;
    return row?.result_summary ?? null;
  }

  purgeFinishedBefore(cutoff: string): number {
    const result = this.db.prepare(`
      DELETE FROM agent_instructions
       WHERE status IN ('done', 'failed') AND finished_at < ?
    `).run(cutoff);
    return Number(result.changes ?? 0);
  }
}
