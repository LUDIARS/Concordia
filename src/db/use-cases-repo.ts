/**
 * ユースケース (use_cases) の repository。 保存と照会だけを持つ。
 *
 * @implements spec/feature/dialogue-context.md §4
 * @implements SPEC-DLG-USE-CASES
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { UseCaseFormatKey, UseCaseWorkMode } from "../dialogue/formats.js";

export interface UseCaseRow {
  id: string;
  name: string;
  slug: string;
  format: UseCaseFormatKey;
  summary: string;
  work_mode: UseCaseWorkMode;
  pre_data: string;
  use_requester_profile: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UseCaseWriteInput {
  name: string;
  slug: string;
  format: UseCaseFormatKey;
  summary: string;
  work_mode: UseCaseWorkMode;
  pre_data: string;
  use_requester_profile: boolean;
}

export class UseCasesRepo {
  constructor(private readonly db: Database.Database) {}

  list(options: { includeArchived?: boolean } = {}): UseCaseRow[] {
    const where = options.includeArchived ? "" : "WHERE archived_at IS NULL";
    return this.db.prepare(`SELECT * FROM use_cases ${where} ORDER BY name, id`).all() as UseCaseRow[];
  }

  find(id: string): UseCaseRow | null {
    return (this.db.prepare("SELECT * FROM use_cases WHERE id = ?").get(id) as UseCaseRow | undefined) ?? null;
  }

  findBySlug(slug: string): UseCaseRow | null {
    return (this.db.prepare("SELECT * FROM use_cases WHERE slug = ?").get(slug) as UseCaseRow | undefined) ?? null;
  }

  create(input: UseCaseWriteInput, now: number = Date.now()): UseCaseRow {
    const id = `uc_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO use_cases(id, name, slug, format, summary, work_mode, pre_data, use_requester_profile,
        archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id, input.name, input.slug, input.format, input.summary, input.work_mode, input.pre_data,
      input.use_requester_profile ? 1 : 0, now, now,
    );
    return this.find(id)!;
  }

  patch(id: string, input: Partial<UseCaseWriteInput>, now: number = Date.now()): UseCaseRow | null {
    const row = this.find(id);
    if (!row) return null;
    this.db.prepare(`
      UPDATE use_cases
      SET name = ?, slug = ?, format = ?, summary = ?, work_mode = ?, pre_data = ?, use_requester_profile = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? row.name,
      input.slug ?? row.slug,
      input.format ?? row.format,
      input.summary ?? row.summary,
      input.work_mode ?? row.work_mode,
      input.pre_data ?? row.pre_data,
      input.use_requester_profile === undefined ? row.use_requester_profile : (input.use_requester_profile ? 1 : 0),
      now,
      id,
    );
    return this.find(id);
  }

  /** 廃止 / 復帰 (冪等)。 */
  setArchived(id: string, archived: boolean, now: number = Date.now()): UseCaseRow | null {
    const row = this.find(id);
    if (!row) return null;
    if ((row.archived_at !== null) === archived) return row;
    this.db.prepare("UPDATE use_cases SET archived_at = ?, updated_at = ? WHERE id = ?").run(archived ? now : null, now, id);
    return this.find(id);
  }

  /** 部署から参照されている数 (削除の可否判定用)。 */
  countDepartmentReferences(id: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM departments WHERE use_case_id = ?").get(id) as { n: number };
    return row.n;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM use_cases WHERE id = ?").run(id).changes > 0;
  }
}
