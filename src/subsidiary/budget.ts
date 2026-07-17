/**
 * 子会社の日次トークン予算トラッカー。
 *
 * 子会社が起動した delegation セッションは metadata.subsidiary_id でタグ付けされる
 * (api/sessions.ts が pending spawn を claim して焼く)。 当日 (local "YYYY-MM-DD") に
 * 始まったその子会社のセッション群の provider ログ累積トークンを合算し、 子会社ごとの
 * 「本日の消費」 とする。 予算 (daily_token_budget) を超えていれば受付を止める。
 *
 * グローバル予算 (cost/usage-tracker.ts) のような delta 累積は不要 — セッションを
 * subsidiary_id で直接帰属でき、 ログから読む累積は冪等なため (再起動で二重計上しない)。
 *
 * spec/feature/subsidiary-delegation.md §7。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { readSessionUsage } from "../cost/log-usage.js";
import { localDateIso } from "../cost/usage-tracker.js";

/** 予算判定に必要な子会社の最小フィールド。 */
export interface BudgetSubsidiary {
  id: string;
  daily_token_budget: number;
}

export interface SubsidiaryBudgetStatus {
  /** 当日 (local) にこの子会社が消費した累積トークン。 */
  todayTokens: number;
  /** 設定中の日次予算 (トークン)。 0 = 無制限。 */
  budget: number;
  /** 予算超過で受付ブロック中か (budget>0 かつ todayTokens>=budget)。 */
  blocked: boolean;
  /** 当日の日付 (local "YYYY-MM-DD")。 */
  dateIso: string;
}

export interface SubsidiaryBudgetTrackerDeps {
  sessionsRepo: SessionsRepo;
  /** セッション 1 本の累積トークンを読む (テスト差し替え用)。 既定 readSessionUsage。 */
  readUsage?: (s: SessionRow) => Promise<{ total: number } | null>;
  /** 時刻プロバイダ (テスト差し替え用)。 既定 Date.now。 */
  now?: () => number;
}

export class SubsidiaryBudgetTracker {
  private readonly now: () => number;
  private readonly readUsage: (s: SessionRow) => Promise<{ total: number } | null>;

  constructor(private readonly deps: SubsidiaryBudgetTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.readUsage = deps.readUsage ?? readSessionUsage;
  }

  /** 当日 (local) にこの子会社が消費した累積トークン。 */
  async todayTokens(subsidiaryId: string, nowMs = this.now()): Promise<number> {
    const [start, end] = localDayRange(nowMs);
    const rows = this.deps.sessionsRepo.listSessionsInRange(start, end);
    let total = 0;
    for (const s of rows) {
      if (readSubsidiaryId(s.metadata) !== subsidiaryId) continue;
      const usage = await this.readUsage(s);
      if (usage && usage.total > 0) total += usage.total;
    }
    return total;
  }

  /** 当日の消費 / 予算 / block 判定を返す。 */
  async status(sub: BudgetSubsidiary, nowMs = this.now()): Promise<SubsidiaryBudgetStatus> {
    const budget = Math.max(0, Math.floor(sub.daily_token_budget || 0));
    const todayTokens = await this.todayTokens(sub.id, nowMs);
    return {
      todayTokens,
      budget,
      blocked: budget > 0 && todayTokens >= budget,
      dateIso: localDateIso(nowMs),
    };
  }

  /** 予算超過でブロック中か (enforcement 用ショートカット)。 */
  async isOverBudget(sub: BudgetSubsidiary, nowMs = this.now()): Promise<boolean> {
    return (await this.status(sub, nowMs)).blocked;
  }
}

/** epoch(ms) → その local 日の [00:00, 翌00:00) の epoch(ms) 範囲。 */
export function localDayRange(nowMs: number): [number, number] {
  const d = new Date(nowMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return [start, end];
}
