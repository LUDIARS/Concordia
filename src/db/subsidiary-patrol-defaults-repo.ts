/**
 * 子会社ごとの巡回チャットの既定値 (spec/plan/2026-10-15-patrol-subsidiary-rules-design.md §2)。
 * 行が無い子会社は全体の既定値を使う。 config の検証は patrol-config.ts の SubsidiaryPatrolDefaults が持つ。
 */

import type Database from "better-sqlite3";

export interface SubsidiaryPatrolDefaultsRow {
  subsidiary_id: string;
  /** JSON (SubsidiaryPatrolDefaults)。 */
  config: string;
  updated_at: number;
  updated_by: string;
}

export class SubsidiaryPatrolDefaultsRepo {
  constructor(private readonly db: Database.Database) {}

  get(subsidiaryId: string): SubsidiaryPatrolDefaultsRow | null {
    return (this.db
      .prepare(`SELECT * FROM subsidiary_patrol_defaults WHERE subsidiary_id = ?`)
      .get(subsidiaryId) as SubsidiaryPatrolDefaultsRow | undefined) ?? null;
  }

  set(subsidiaryId: string, configJson: string, actor: string, now: number): SubsidiaryPatrolDefaultsRow {
    this.db
      .prepare(
        `INSERT INTO subsidiary_patrol_defaults(subsidiary_id, config, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(subsidiary_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(subsidiaryId, configJson, now, actor);
    return this.get(subsidiaryId)!;
  }
}
