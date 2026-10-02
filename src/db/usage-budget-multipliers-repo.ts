/**
 * 月次予算の属性 (社員名簿の役職) ごとのコスト倍率 (usage_budget_role_multipliers) の repository。
 * 行が無い役職は倍率 1。 保存と照会だけを持ち、 換算は src/cost/budget-multiplier.ts が持つ。
 *
 * @implements SPEC-USAGE-BUDGET-STORE
 */

import type Database from "better-sqlite3";
import type { StaffRole } from "../staff/roles.js";

export interface UsageBudgetRoleMultiplierRow {
  role: StaffRole;
  multiplier: number;
  updated_by: string | null;
  updated_at: number;
}

export class UsageBudgetMultipliersRepo {
  constructor(private readonly db: Database.Database) {}

  list(): UsageBudgetRoleMultiplierRow[] {
    return this.db.prepare("SELECT * FROM usage_budget_role_multipliers ORDER BY role").all() as UsageBudgetRoleMultiplierRow[];
  }

  find(role: StaffRole): UsageBudgetRoleMultiplierRow | null {
    return (this.db.prepare("SELECT * FROM usage_budget_role_multipliers WHERE role = ?").get(role) as
      UsageBudgetRoleMultiplierRow | undefined) ?? null;
  }

  upsert(input: { role: StaffRole; multiplier: number; updated_by: string | null }, now = Date.now()): UsageBudgetRoleMultiplierRow {
    this.db.prepare(`
      INSERT INTO usage_budget_role_multipliers(role, multiplier, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        multiplier = excluded.multiplier, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(input.role, input.multiplier, input.updated_by, now);
    return this.find(input.role)!;
  }

  /** 倍率を外す (1 に戻す)。 */
  remove(role: StaffRole): boolean {
    return this.db.prepare("DELETE FROM usage_budget_role_multipliers WHERE role = ?").run(role).changes > 0;
  }
}
