/**
 * 個人の消費の保存 (personal_budget_monthly_usage / personal_budget_session_seen) の repository。
 *
 * セッションの累積トークンの baseline・月間分の累積・報酬分の debit を 1 つのトランザクションで
 * 進めるので、 再起動や並行する計上で同じ消費を二重に引かない (CC-PBUDGET-INV-05)。
 * 割り当ての判断は呼び出し側の純関数に任せ、 ここは読んだ状態を渡して結果を保存するだけにする。
 *
 * @implements spec/feature/personal-ai-budget.md §8 / §10
 * @implements SPEC-PBUDGET-CONSUME
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ConsumptionState {
  /** 最後に数えた累積。 初めて見るセッションなら null。 */
  lastTotal: number | null;
  monthlyUsed: number;
  rewardBalance: number;
}

export interface ConsumptionPlan {
  /** 今回数える差分。 0 なら何も進めない (初回は baseline だけ記録する)。 */
  delta: number;
  /** 初めて見たセッションで記録する baseline。 */
  baseline: number;
  monthly: number;
  reward: number;
}

export interface ConsumptionResult {
  delta: number;
  monthly: number;
  reward: number;
}

export class PersonalBudgetUsageRepo {
  constructor(private readonly db: Database.Database) {}

  /** その月の月間分の累積。 */
  monthlyUsed(personId: string, period: string): number {
    const row = this.db.prepare(
      "SELECT used_tokens FROM personal_budget_monthly_usage WHERE person_id = ? AND period = ?",
    ).get(personId, period) as { used_tokens: number } | undefined;
    return row?.used_tokens ?? 0;
  }

  lastTotal(sessionId: string): number | null {
    const row = this.db.prepare(
      "SELECT last_total FROM personal_budget_session_seen WHERE session_id = ?",
    ).get(sessionId) as { last_total: number } | undefined;
    return row?.last_total ?? null;
  }

  /**
   * セッション 1 本の消費を計上する。
   *
   * `plan` はトランザクションの中で読んだ状態 (baseline・月間分の累積・報酬分の残り) を受け取り、
   * 差分と割り当てを返す。 報酬分の debit は `(session, 月)` で 1 行に足し込む。
   */
  applyConsumption(input: {
    sessionId: string;
    personId: string;
    period: string;
    total: number;
    now?: number;
    plan: (state: ConsumptionState) => ConsumptionPlan;
  }): ConsumptionResult {
    const now = input.now ?? Date.now();
    const total = Math.max(0, Math.floor(input.total));
    const run = this.db.transaction((): ConsumptionResult => {
      const lastTotal = this.lastTotal(input.sessionId);
      const monthlyUsed = this.monthlyUsed(input.personId, input.period);
      const balanceRow = this.db.prepare(
        "SELECT COALESCE(SUM(tokens), 0) AS balance FROM personal_budget_ledger WHERE person_id = ?",
      ).get(input.personId) as { balance: number };
      const rewardBalance = Math.max(0, balanceRow.balance);
      const plan = input.plan({ lastTotal, monthlyUsed, rewardBalance });
      const delta = Math.max(0, Math.floor(plan.delta));
      if (lastTotal === null) {
        this.db.prepare(`
          INSERT INTO personal_budget_session_seen(session_id, person_id, last_total, updated_at) VALUES (?, ?, ?, ?)
        `).run(input.sessionId, input.personId, delta > 0 ? total : Math.max(0, Math.floor(plan.baseline)), now);
      } else if (delta > 0) {
        this.db.prepare(
          "UPDATE personal_budget_session_seen SET last_total = ?, updated_at = ? WHERE session_id = ?",
        ).run(total, now, input.sessionId);
      }
      if (delta === 0) return { delta: 0, monthly: 0, reward: 0 };
      // 保存する量は差分と残高の範囲に収める (割り当て関数の結果を信用しきらない)。
      const reward = Math.min(Math.max(0, Math.floor(plan.reward)), rewardBalance, delta);
      const monthly = delta - reward;
      if (monthly > 0) {
        this.db.prepare(`
          INSERT INTO personal_budget_monthly_usage(person_id, period, used_tokens, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(person_id, period) DO UPDATE SET
            used_tokens = used_tokens + excluded.used_tokens, updated_at = excluded.updated_at
        `).run(input.personId, input.period, monthly, now);
      }
      if (reward > 0) {
        this.db.prepare(`
          INSERT INTO personal_budget_ledger(id, person_id, entry_type, tokens, session_id, period,
            notify_state, created_at, updated_at)
          VALUES (?, ?, 'debit', ?, ?, ?, 'none', ?, ?)
          ON CONFLICT(session_id, period, entry_type) WHERE session_id IS NOT NULL DO UPDATE SET
            tokens = tokens + excluded.tokens, updated_at = excluded.updated_at
        `).run(`pbl_${randomUUID().replace(/-/g, "")}`, input.personId, -reward, input.sessionId, input.period, now, now);
      }
      return { delta, monthly, reward };
    });
    return run.immediate();
  }
}
