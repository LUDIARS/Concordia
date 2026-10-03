/**
 * 月次予算の属性 (Discord のロール) ごとのコスト倍率 (usage_budget_role_multipliers) の repository。
 * 行が無いロールは倍率 1。 保存と照会だけを持ち、 どのロールの倍率を使うかは src/cost/budget-role-multiplier.ts が持つ。
 *
 * @implements SPEC-USAGE-BUDGET-STORE
 */

import type Database from "better-sqlite3";

export interface UsageBudgetRoleMultiplierRow {
  /** Discord のロール id。 */
  role_id: string;
  /** ロールが属する guild の id。 */
  guild_id: string;
  multiplier: number;
  updated_by: string | null;
  updated_at: number;
}

export class UsageBudgetMultipliersRepo {
  constructor(private readonly db: Database.Database) {}

  list(): UsageBudgetRoleMultiplierRow[] {
    return this.db.prepare("SELECT * FROM usage_budget_role_multipliers ORDER BY guild_id, role_id")
      .all() as UsageBudgetRoleMultiplierRow[];
  }

  find(roleId: string): UsageBudgetRoleMultiplierRow | null {
    return (this.db.prepare("SELECT * FROM usage_budget_role_multipliers WHERE role_id = ?").get(roleId) as
      UsageBudgetRoleMultiplierRow | undefined) ?? null;
  }

  upsert(
    input: { role_id: string; guild_id: string; multiplier: number; updated_by: string | null },
    now = Date.now(),
  ): UsageBudgetRoleMultiplierRow {
    this.db.prepare(`
      INSERT INTO usage_budget_role_multipliers(role_id, guild_id, multiplier, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET
        guild_id = excluded.guild_id, multiplier = excluded.multiplier,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(input.role_id, input.guild_id, input.multiplier, input.updated_by, now);
    return this.find(input.role_id)!;
  }

  /** 倍率を外す (1 に戻す)。 */
  remove(roleId: string): boolean {
    return this.db.prepare("DELETE FROM usage_budget_role_multipliers WHERE role_id = ?").run(roleId).changes > 0;
  }
}
