/**
 * ユーザー / チームの月次トークン上限予算 (usage_budgets / usage_budget_notices) の repository。
 * 保存と照会だけを持つ。 消費の集計と残りの判定は src/cost/usage-budget*.ts が持つ。
 *
 * @implements SPEC-USAGE-BUDGET-STORE
 */

import type Database from "better-sqlite3";

export type UsageBudgetScope = "user" | "team";
export type UsageBudgetThreshold = 80 | 100;

export interface UsageBudgetRow {
  scope: UsageBudgetScope;
  target_id: string;
  limit_tokens: number;
  updated_by: string | null;
  updated_at: number;
}

export class UsageBudgetsRepo {
  constructor(private readonly db: Database.Database) {}

  list(): UsageBudgetRow[] {
    return this.db.prepare("SELECT * FROM usage_budgets ORDER BY scope, target_id").all() as UsageBudgetRow[];
  }

  find(scope: UsageBudgetScope, targetId: string): UsageBudgetRow | null {
    return (this.db.prepare("SELECT * FROM usage_budgets WHERE scope = ? AND target_id = ?").get(scope, targetId) as
      UsageBudgetRow | undefined) ?? null;
  }

  upsert(input: { scope: UsageBudgetScope; target_id: string; limit_tokens: number; updated_by: string | null }, now = Date.now()): UsageBudgetRow {
    this.db.prepare(`
      INSERT INTO usage_budgets(scope, target_id, limit_tokens, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope, target_id) DO UPDATE SET
        limit_tokens = excluded.limit_tokens, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(input.scope, input.target_id, input.limit_tokens, input.updated_by, now);
    return this.find(input.scope, input.target_id)!;
  }

  /** 予算を外す (無制限に戻す)。 */
  remove(scope: UsageBudgetScope, targetId: string): boolean {
    return this.db.prepare("DELETE FROM usage_budgets WHERE scope = ? AND target_id = ?").run(scope, targetId).changes > 0;
  }

  /** その月・閾値の通知を初めて記録したときだけ true (同じ通知を二度出さない)。 */
  claimNotice(scope: UsageBudgetScope, targetId: string, month: string, threshold: UsageBudgetThreshold, now = Date.now()): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO usage_budget_notices(scope, target_id, month, threshold, notified_at) VALUES (?, ?, ?, ?, ?)
    `).run(scope, targetId, month, threshold, now).changes > 0;
  }

  /** 通知の記録を取り消す (配送に失敗したとき、 次の見回りで出し直す)。 */
  releaseNotice(scope: UsageBudgetScope, targetId: string, month: string, threshold: UsageBudgetThreshold): void {
    this.db.prepare("DELETE FROM usage_budget_notices WHERE scope = ? AND target_id = ? AND month = ? AND threshold = ?")
      .run(scope, targetId, month, threshold);
  }
}
