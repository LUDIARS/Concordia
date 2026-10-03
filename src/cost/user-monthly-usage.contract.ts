/** @implements spec/feature/usage-budgets.md §6 — budget-C-7 ユーザーごとの今月の消費 */
/**
 * budget-C-7: every person who consumed this month gets a row whether or not they have a budget, and every user
 * budget gets a row even with no consumption. The team part never exceeds the person's total, and a row carries
 * the budget evaluation exactly when that user has a budget.
 */
interface Row { user_id: string; consumed_tokens: number; team_tokens: number; budget: unknown }
interface PersonUsage { total: number; team: number }
interface Budget { scope: string; target_id: string }

export default {
  post(result: unknown, persons: unknown, budgets: unknown): boolean {
    if (!Array.isArray(result) || !(persons instanceof Map) || !Array.isArray(budgets)) return false;
    const rows = result as Row[];
    const byId = new Map(rows.map((row) => [row.user_id, row]));
    if (byId.size !== rows.length) return false;
    const userBudgets = new Set((budgets as Budget[]).filter((b) => b.scope === "user").map((b) => b.target_id));
    for (const [userId, usage] of persons as Map<string, PersonUsage>) {
      const row = byId.get(userId);
      if (!row || row.consumed_tokens !== Math.floor(usage.total)) return false;
    }
    for (const id of userBudgets) if (!byId.has(id)) return false;
    return rows.every((row) => row.team_tokens <= row.consumed_tokens
      && (row.budget !== null) === userBudgets.has(row.user_id));
  },
};
