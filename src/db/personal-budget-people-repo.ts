/**
 * 個人の AI 予算の個人 (personal_budget_people) の repository。
 * 会社 × platform × user で 1 行。 月間分の上限の上書きを持つ (null = 子会社の既定)。
 *
 * @implements spec/feature/personal-ai-budget.md §8
 * @implements SPEC-PBUDGET-VIEW
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BudgetPlatform, PersonIdentity } from "../personal-budget/types.js";

export interface PersonalBudgetPersonRow {
  id: string;
  subsidiary_id: string;
  platform: BudgetPlatform;
  platform_user_id: string;
  display_name: string;
  /** 月間分の上限の上書き。 null = 子会社の既定値に従う。 */
  monthly_token_limit: number | null;
  created_at: number;
  updated_at: number;
}

export class PersonalBudgetPeopleRepo {
  constructor(private readonly db: Database.Database) {}

  find(identity: PersonIdentity): PersonalBudgetPersonRow | null {
    return (this.db.prepare(`
      SELECT * FROM personal_budget_people WHERE subsidiary_id = ? AND platform = ? AND platform_user_id = ?
    `).get(identity.subsidiaryId, identity.platform, identity.platformUserId) as PersonalBudgetPersonRow | undefined) ?? null;
  }

  findById(id: string): PersonalBudgetPersonRow | null {
    return (this.db.prepare("SELECT * FROM personal_budget_people WHERE id = ?").get(id) as PersonalBudgetPersonRow | undefined) ?? null;
  }

  /** 同じ人 (platform × user) の全社分。 `/budget` と調整の候補に使う。 */
  listByUser(platform: BudgetPlatform, platformUserId: string): PersonalBudgetPersonRow[] {
    return this.db.prepare(`
      SELECT * FROM personal_budget_people WHERE platform = ? AND platform_user_id = ? ORDER BY subsidiary_id
    `).all(platform, platformUserId) as PersonalBudgetPersonRow[];
  }

  /** 無ければ作る。 既にあれば表示名が空のときだけ埋める。 競合した挿入は一意制約で 1 行に収束する。 */
  ensure(identity: PersonIdentity, displayName = "", now: number = Date.now()): PersonalBudgetPersonRow {
    const name = displayName.trim().slice(0, 100);
    this.db.prepare(`
      INSERT INTO personal_budget_people(id, subsidiary_id, platform, platform_user_id, display_name,
        monthly_token_limit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(subsidiary_id, platform, platform_user_id) DO NOTHING
    `).run(`pbp_${randomUUID().replace(/-/g, "")}`, identity.subsidiaryId, identity.platform, identity.platformUserId, name, now, now);
    const row = this.find(identity)!;
    if (!row.display_name && name) {
      this.db.prepare("UPDATE personal_budget_people SET display_name = ?, updated_at = ? WHERE id = ?").run(name, now, row.id);
      return this.findById(row.id)!;
    }
    return row;
  }

  /** 月間分の上限の上書き。 null で子会社の既定へ戻す。 */
  setMonthlyLimit(id: string, limit: number | null, now: number = Date.now()): PersonalBudgetPersonRow | null {
    const changed = this.db.prepare(
      "UPDATE personal_budget_people SET monthly_token_limit = ?, updated_at = ? WHERE id = ?",
    ).run(limit === null ? null : Math.max(0, Math.floor(limit)), now, id).changes > 0;
    return changed ? this.findById(id) : null;
  }

  /** 一覧 (ページング)。 `subsidiaryId` 指定でその会社だけ。 */
  list(input: { subsidiaryId?: string | null; limit: number; offset: number }): { people: PersonalBudgetPersonRow[]; total: number } {
    const where = input.subsidiaryId ? "WHERE subsidiary_id = ?" : "";
    const args = input.subsidiaryId ? [input.subsidiaryId] : [];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM personal_budget_people ${where}`).get(...args) as { n: number }).n;
    const people = this.db.prepare(`
      SELECT * FROM personal_budget_people ${where}
      ORDER BY subsidiary_id, display_name, platform_user_id LIMIT ? OFFSET ?
    `).all(...args, input.limit, input.offset) as PersonalBudgetPersonRow[];
    return { people, total };
  }
}
