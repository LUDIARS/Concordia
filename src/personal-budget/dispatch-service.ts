/**
 * 払い出しの判定の port (use case)。 払い出しを止める経路 (子会社ゲート) は、 全体と子会社の
 * 日次 budget の状態を渡して「この依頼者を通してよいか・どこから引くか」を聞くだけにする。
 * observability の表 (全体・子会社の budget) はここから書かない。
 *
 * @implements SPEC-PBUDGET-CONSUME
 * @implements spec/feature/personal-ai-budget.md §3
 */

import { decideDispatch, type DispatchDecision, type DispatchStopReason } from "./dispatch-policy.js";
import { resolveBudgetPerson } from "./person-resolution.js";
import type { LedgerStore, MonthlyLimitResolver, PeopleStore, UsageStore } from "./ports.js";
import { localMonth, type BudgetPlatform } from "./types.js";

export interface DispatchRequest {
  subsidiaryId: string | null;
  platform: BudgetPlatform;
  userId: string;
  userLabel?: string;
  /** 子会社の日次 budget が超過中か (observability が判定した結果)。 */
  subsidiaryOver: boolean;
}

/** 払い出しを止める経路へ渡す port。 */
export interface PersonalBudgetDispatchPort {
  admit(request: DispatchRequest): DispatchDecision;
}

export interface DispatchServiceDeps {
  people: PeopleStore;
  usage: UsageStore;
  ledger: LedgerStore;
  monthlyLimit: MonthlyLimitResolver;
  /** 全体の日次 budget が超過中か。 */
  isGlobalOver: () => boolean;
  now?: () => number;
}

export class PersonalBudgetDispatch implements PersonalBudgetDispatchPort {
  private readonly now: () => number;

  constructor(private readonly deps: DispatchServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  admit(request: DispatchRequest): DispatchDecision {
    const resolved = resolveBudgetPerson({
      subsidiaryId: request.subsidiaryId,
      platform: request.platform,
      platformUserId: request.userId,
    });
    if (!resolved.ok) {
      // 本社メンバー・個人を特定できない依頼には個人の予算を適用しない (CC-PBUDGET-INV-07)。
      return decideDispatch({ globalOver: false, subsidiaryOver: request.subsidiaryOver, person: null });
    }
    const now = this.now();
    // 依頼の時点で個人の行を作る。 これより後に始まるセッションの消費は 0 から数えられる。
    const person = this.deps.people.ensure(resolved.identity, request.userLabel ?? "", now);
    return decideDispatch({
      globalOver: this.deps.isGlobalOver(),
      subsidiaryOver: request.subsidiaryOver,
      person: {
        monthlyLimit: this.deps.monthlyLimit(person),
        monthlyUsed: this.deps.usage.monthlyUsed(person.id, localMonth(now)),
        rewardBalance: this.deps.ledger.balance(person.id),
      },
    });
  }
}

const STOP_LABEL: Record<DispatchStopReason, string> = {
  global_over: "全体のコスト上限に達しているため、いまは受け付けられません。",
  subsidiary_over: "子会社の本日のコスト予算を使い切っています。",
  monthly_exhausted: "今月の月間分を使い切りました。月初 (ローカル時刻) に戻ります。",
};

/**
 * 止めた理由を依頼者へ返す文面。 共有チャンネルへ出る返信なので残高の数字は載せず、
 * 本人にだけ見える `/budget` を案内する (CC-PBUDGET-INV-08)。
 */
export function renderDispatchStop(reason: DispatchStopReason): string {
  return `💸 ${STOP_LABEL[reason]} 報酬分の残りは /budget で確認できます (本人にだけ表示します)。`;
}
