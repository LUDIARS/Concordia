/**
 * 人の訂正 (use_case_corrections) の repository。 会社 (subsidiary_id) ごとに分けて
 * 保存し、 起動時の読み出しも会社で絞る (CC-DLG-INV-01)。
 *
 * @implements spec/feature/dialogue-context.md §4 / §6
 * @implements SPEC-DLG-CORRECTIONS
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type CorrectionSource = "discord" | "webui" | "api";

export interface CorrectionRow {
  id: string;
  use_case_id: string;
  subsidiary_id: string | null;
  department_id: string | null;
  session_id: string | null;
  source: CorrectionSource;
  question: string;
  correction: string;
  author: string;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface CorrectionCreateInput {
  use_case_id: string;
  subsidiary_id: string | null;
  department_id: string | null;
  session_id: string | null;
  source: CorrectionSource;
  question: string;
  correction: string;
  author: string;
}

export interface CorrectionPatchInput {
  question?: string;
  correction?: string;
  active?: boolean;
}

export class UseCaseCorrectionsRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: CorrectionCreateInput, now: number = Date.now()): CorrectionRow {
    const id = `corr_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO use_case_corrections(id, use_case_id, subsidiary_id, department_id, session_id, source,
        question, correction, author, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id, input.use_case_id, input.subsidiary_id, input.department_id, input.session_id, input.source,
      input.question, input.correction, input.author, now, now,
    );
    return this.find(id)!;
  }

  find(id: string): CorrectionRow | null {
    return (this.db.prepare("SELECT * FROM use_case_corrections WHERE id = ?").get(id) as CorrectionRow | undefined) ?? null;
  }

  /** 管理画面用。 subsidiaryId を渡すとその会社だけ、 undefined なら全会社。 */
  list(useCaseId: string, options: { subsidiaryId?: string | null; includeInactive?: boolean } = {}): CorrectionRow[] {
    const where = ["use_case_id = ?"];
    const args: unknown[] = [useCaseId];
    if (options.subsidiaryId !== undefined) {
      where.push("subsidiary_id IS ?");
      args.push(options.subsidiaryId);
    }
    if (!options.includeInactive) where.push("active = 1");
    return this.db.prepare(
      `SELECT * FROM use_case_corrections WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`,
    ).all(...args) as CorrectionRow[];
  }

  /** 起動時に渡す分: 同じ会社・有効・新しい順に最大 limit 件。 */
  listForLaunch(useCaseId: string, subsidiaryId: string | null, limit: number): CorrectionRow[] {
    return this.db.prepare(`
      SELECT * FROM use_case_corrections
      WHERE use_case_id = ? AND subsidiary_id IS ? AND active = 1
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(useCaseId, subsidiaryId, limit) as CorrectionRow[];
  }

  patch(id: string, input: CorrectionPatchInput, now: number = Date.now()): CorrectionRow | null {
    const row = this.find(id);
    if (!row) return null;
    this.db.prepare(`
      UPDATE use_case_corrections SET question = ?, correction = ?, active = ?, updated_at = ? WHERE id = ?
    `).run(
      input.question ?? row.question,
      input.correction ?? row.correction,
      input.active === undefined ? row.active : (input.active ? 1 : 0),
      now,
      id,
    );
    return this.find(id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM use_case_corrections WHERE id = ?").run(id).changes > 0;
  }
}
