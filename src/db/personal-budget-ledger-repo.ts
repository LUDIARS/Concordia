/**
 * 報酬分の台帳 (personal_budget_ledger) の repository。
 *
 * 残高は台帳の合計。 `tokens` は報酬分の増減 (grant / 増額 = 正、 debit / revoke / 減額 = 負)。
 * 残高を読んでから書く操作は BEGIN IMMEDIATE の中で行い、 複数プロセスからでも負にしない
 * (CC-PBUDGET-INV-02)。 同じ根拠の行は一意制約で 1 つに収束する (CC-PBUDGET-INV-04)。
 * 残高・理由をログへ出さない (CC-PBUDGET-INV-08)。
 *
 * @implements spec/feature/personal-ai-budget.md §8 / §10
 * @implements SPEC-PBUDGET-REWARD
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { LedgerEntryType, RewardKind } from "../personal-budget/types.js";

export type LedgerNotifyState = "none" | "pending" | "delivered" | "failed";

export interface PersonalBudgetLedgerRow {
  id: string;
  person_id: string;
  entry_type: LedgerEntryType;
  /** 報酬分の増減 (符号付き)。 */
  tokens: number;
  reward_kind: RewardKind | null;
  source_ref: string | null;
  session_id: string | null;
  period: string | null;
  actor: string | null;
  reason: string | null;
  notify_state: LedgerNotifyState;
  notify_attempts: number;
  created_at: number;
  updated_at: number;
}

function newLedgerId(): string {
  return `pbl_${randomUUID().replace(/-/g, "")}`;
}

export class PersonalBudgetLedgerRepo {
  constructor(private readonly db: Database.Database) {}

  /** 報酬分の残り (台帳の合計)。 */
  balance(personId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(tokens), 0) AS balance FROM personal_budget_ledger WHERE person_id = ?",
    ).get(personId) as { balance: number };
    return Math.max(0, row.balance);
  }

  findById(id: string): PersonalBudgetLedgerRow | null {
    return (this.db.prepare("SELECT * FROM personal_budget_ledger WHERE id = ?").get(id) as PersonalBudgetLedgerRow | undefined) ?? null;
  }

  findBySource(entryType: "grant" | "revoke", kind: RewardKind, sourceRef: string): PersonalBudgetLedgerRow | null {
    return (this.db.prepare(`
      SELECT * FROM personal_budget_ledger WHERE entry_type = ? AND reward_kind = ? AND source_ref = ?
    `).get(entryType, kind, sourceRef) as PersonalBudgetLedgerRow | undefined) ?? null;
  }

  /** 個人単位の台帳 (新しい順、 ページング)。 */
  listForPerson(personId: string, input: { limit: number; offset: number }): { entries: PersonalBudgetLedgerRow[]; total: number } {
    const total = (this.db.prepare(
      "SELECT COUNT(*) AS n FROM personal_budget_ledger WHERE person_id = ?",
    ).get(personId) as { n: number }).n;
    const entries = this.db.prepare(`
      SELECT * FROM personal_budget_ledger WHERE person_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(personId, input.limit, input.offset) as PersonalBudgetLedgerRow[];
    return { entries, total };
  }

  /**
   * 報奨を付ける。 同じ `(kind, source_ref)` が既にあればその行を返し、 新しい行は作らない。
   */
  grant(input: { personId: string; kind: RewardKind; sourceRef: string; tokens: number; now?: number }): {
    entry: PersonalBudgetLedgerRow; created: boolean;
  } {
    const now = input.now ?? Date.now();
    const run = this.db.transaction(() => {
      const existing = this.findBySource("grant", input.kind, input.sourceRef);
      if (existing) return { entry: existing, created: false };
      const id = newLedgerId();
      this.db.prepare(`
        INSERT INTO personal_budget_ledger(id, person_id, entry_type, tokens, reward_kind, source_ref,
          notify_state, created_at, updated_at)
        VALUES (?, ?, 'grant', ?, ?, ?, 'pending', ?, ?)
      `).run(id, input.personId, input.tokens, input.kind, input.sourceRef, now, now);
      return { entry: this.findById(id)!, created: true };
    });
    return run.immediate();
  }

  /**
   * 報奨を取り消す。 引く量は呼び出し側の関数が「付与量と今の残高」から決める (未使用ぶんが上限)。
   * 付与が無ければ null。 取り消し済みならその行を返す。
   */
  revoke(input: {
    kind: RewardKind; sourceRef: string; reason: string; now?: number;
    decide: (state: { grantedTokens: number; rewardBalance: number }) => number;
  }): { entry: PersonalBudgetLedgerRow; created: boolean } | null {
    const now = input.now ?? Date.now();
    const run = this.db.transaction(() => {
      const grant = this.findBySource("grant", input.kind, input.sourceRef);
      if (!grant) return null;
      const existing = this.findBySource("revoke", input.kind, input.sourceRef);
      if (existing) return { entry: existing, created: false };
      const tokens = Math.min(
        Math.max(0, Math.floor(input.decide({ grantedTokens: grant.tokens, rewardBalance: this.balance(grant.person_id) }))),
        this.balance(grant.person_id),
      );
      const id = newLedgerId();
      this.db.prepare(`
        INSERT INTO personal_budget_ledger(id, person_id, entry_type, tokens, reward_kind, source_ref, reason,
          notify_state, created_at, updated_at)
        VALUES (?, ?, 'revoke', ?, ?, ?, ?, 'pending', ?, ?)
      `).run(id, grant.person_id, -tokens, input.kind, input.sourceRef, input.reason, now, now);
      return { entry: this.findById(id)!, created: true };
    });
    return run.immediate();
  }

  /**
   * 本社の調整を書く。 増減量は、 トランザクションの中で読んだ残高から呼び出し側の関数が決める。
   * 関数が null を返したら何も書かない。
   */
  adjust(input: {
    personId: string; actor: string; now?: number;
    decide: (rewardBalance: number) => { applied: number; reason: string } | null;
  }): PersonalBudgetLedgerRow | null {
    const now = input.now ?? Date.now();
    const run = this.db.transaction(() => {
      const balance = this.balance(input.personId);
      const decision = input.decide(balance);
      if (!decision || decision.applied === 0) return null;
      // 関数の結果に関わらず、 残高を負にする減額は書かない。
      const applied = decision.applied < 0 ? -Math.min(-decision.applied, balance) : decision.applied;
      if (applied === 0) return null;
      const id = newLedgerId();
      this.db.prepare(`
        INSERT INTO personal_budget_ledger(id, person_id, entry_type, tokens, reward_kind, source_ref, actor, reason,
          notify_state, created_at, updated_at)
        VALUES (?, ?, 'manual', ?, 'manual', ?, ?, ?, 'pending', ?, ?)
      `).run(id, input.personId, applied, id, input.actor, decision.reason, now, now);
      return this.findById(id)!;
    });
    return run.immediate();
  }

  /** 本人への通知が済んでいない行 (古い順)。 */
  listPendingNotices(limit: number): PersonalBudgetLedgerRow[] {
    return this.db.prepare(`
      SELECT * FROM personal_budget_ledger WHERE notify_state = 'pending' ORDER BY created_at, id LIMIT ?
    `).all(limit) as PersonalBudgetLedgerRow[];
  }

  /** 配達できた。 付与そのものは通知の成否で変えない (CC-INV-06)。 */
  markNoticeDelivered(id: string, now: number = Date.now()): void {
    this.db.prepare(`
      UPDATE personal_budget_ledger SET notify_state = 'delivered', notify_attempts = notify_attempts + 1, updated_at = ?
      WHERE id = ? AND notify_state = 'pending'
    `).run(now, id);
  }

  /** 配達に失敗した。 `giveUp` なら以後は再送しない。 */
  markNoticeFailed(id: string, giveUp: boolean, now: number = Date.now()): void {
    this.db.prepare(`
      UPDATE personal_budget_ledger SET notify_state = ?, notify_attempts = notify_attempts + 1, updated_at = ?
      WHERE id = ? AND notify_state = 'pending'
    `).run(giveUp ? "failed" : "pending", now, id);
  }
}
