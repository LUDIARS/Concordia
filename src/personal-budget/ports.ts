/**
 * 個人の AI 予算の use case が要求する保存の port。 SQLite の repository がこれを実装する。
 * use case は DB 接続を直接持たず、 この小さな操作だけに依存する。
 *
 * @implements spec/feature/personal-ai-budget.md §11
 */

import type { BudgetPlatform, LedgerEntryType, PersonIdentity, RewardKind } from "./types.js";

export interface BudgetPerson {
  id: string;
  subsidiary_id: string;
  platform: BudgetPlatform;
  platform_user_id: string;
  display_name: string;
  monthly_token_limit: number | null;
  created_at: number;
}

export interface LedgerEntry {
  id: string;
  person_id: string;
  entry_type: LedgerEntryType;
  tokens: number;
  reward_kind: RewardKind | null;
  source_ref: string | null;
  session_id: string | null;
  period: string | null;
  actor: string | null;
  reason: string | null;
  notify_state: "none" | "pending" | "delivered" | "failed";
  notify_attempts: number;
  created_at: number;
}

export interface PeopleStore {
  find(identity: PersonIdentity): BudgetPerson | null;
  findById(id: string): BudgetPerson | null;
  listByUser(platform: BudgetPlatform, platformUserId: string): BudgetPerson[];
  ensure(identity: PersonIdentity, displayName?: string, now?: number): BudgetPerson;
}

export interface LedgerStore {
  balance(personId: string): number;
  findBySource(entryType: "grant" | "revoke", kind: RewardKind, sourceRef: string): LedgerEntry | null;
  listForPerson(personId: string, input: { limit: number; offset: number }): { entries: LedgerEntry[]; total: number };
  grant(input: { personId: string; kind: RewardKind; sourceRef: string; tokens: number; now?: number }): {
    entry: LedgerEntry; created: boolean;
  };
  revoke(input: {
    kind: RewardKind; sourceRef: string; reason: string; now?: number;
    decide: (state: { grantedTokens: number; rewardBalance: number }) => number;
  }): { entry: LedgerEntry; created: boolean } | null;
  adjust(input: {
    personId: string; actor: string; now?: number;
    decide: (rewardBalance: number) => { applied: number; reason: string } | null;
  }): LedgerEntry | null;
}

export interface UsageStore {
  monthlyUsed(personId: string, period: string): number;
  applyConsumption(input: {
    sessionId: string;
    personId: string;
    period: string;
    total: number;
    now?: number;
    plan: (state: { lastTotal: number | null; monthlyUsed: number; rewardBalance: number }) => {
      delta: number; baseline: number; monthly: number; reward: number;
    };
  }): { delta: number; monthly: number; reward: number };
}

/** 個人の月間分の上限 (上書き → 子会社の既定 → 0 = 上限なし)。 */
export type MonthlyLimitResolver = (person: Pick<BudgetPerson, "subsidiary_id" | "monthly_token_limit">) => number;

/** 個人の上書きと子会社の既定値から、 効いている月間分の上限を決める。 */
export function effectiveMonthlyLimit(override: number | null, subsidiaryDefault: number | null | undefined): number {
  const pick = override ?? subsidiaryDefault ?? 0;
  return Number.isFinite(pick) && pick > 0 ? Math.floor(pick) : 0;
}
