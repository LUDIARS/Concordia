/**
 * 本社の調整 (use case)。 本社の権限者が特定の個人の報酬分を増減させる。
 *
 * 手順: 権限の確認 → 対象の会社の解決 → 残高を読んで増減量を決める (台帳のトランザクションの中) →
 * 台帳へ `manual` を書く。 本人への通知は台帳の行に待ち状態で残り、 配達の成否で調整を取り消さない。
 * Discord の `/reward` と WebUI は同じこの use case を通す。
 *
 * @implements SPEC-PBUDGET-ADJUST
 * @implements spec/feature/personal-ai-budget.md §6
 */

import {
  ADJUSTMENT_ERROR_LABEL,
  decideAdjustment,
  resolveAdjustmentTarget,
  type AdjustmentError,
  type AdjustmentTargetError,
} from "./adjustment-policy.js";
import type { BudgetPerson, LedgerEntry, LedgerStore, PeopleStore } from "./ports.js";
import type { BudgetPlatform } from "./types.js";

export interface AdjustmentActor {
  /** 台帳に残す操作者 (例: `discord:123`、 `webui`)。 */
  id: string;
  /** 社員名簿の権限者 (既定は管理職以上) か。 */
  authorized: boolean;
}

export type AdjustmentTargetRequest =
  /** 一覧から選んだ既存の個人。 */
  | { personId: string }
  /** 人を指して調整する (`/reward user:@〇〇`)。 所属する子会社は呼び出し側が確かめて渡す。 */
  | {
    platform: BudgetPlatform;
    platformUserId: string;
    displayName?: string;
    memberships: readonly string[];
    requestedSubsidiaryId: string | null;
  };

export interface AdjustmentRequest {
  actor: AdjustmentActor;
  target: AdjustmentTargetRequest;
  tokens: number;
  reason: string;
}

export type AdjustmentOutcome =
  | { ok: true; person: BudgetPerson; entry: LedgerEntry; rewardBalance: number }
  | {
    ok: false;
    error: AdjustmentError | AdjustmentTargetError | "person_not_found";
    message: string;
    /** `ambiguous_subsidiary` のときの候補 (子会社 id)。 */
    candidates: string[];
  };

export interface AdjustmentServiceDeps {
  people: PeopleStore;
  ledger: LedgerStore;
  now?: () => number;
}

export class PersonalBudgetAdjustments {
  private readonly now: () => number;

  constructor(private readonly deps: AdjustmentServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  adjust(request: AdjustmentRequest): AdjustmentOutcome {
    const fail = (
      error: AdjustmentError | AdjustmentTargetError | "person_not_found",
      candidates: string[] = [],
    ): AdjustmentOutcome => ({
      ok: false,
      error,
      message: error === "person_not_found" ? "対象の個人が見つかりません。" : ADJUSTMENT_ERROR_LABEL[error],
      candidates,
    });

    // 権限と入力の確認を、 対象の解決や行の作成より先に行う (権限の無い操作で個人の行を作らない)。
    const precheck = decideAdjustment({
      actorAuthorized: request.actor.authorized,
      tokens: request.tokens,
      reason: request.reason,
      // 残高はまだ読まない。 減額の上限はトランザクションの中で決める。
      rewardBalance: Number.MAX_SAFE_INTEGER,
    });
    if (!precheck.ok) return fail(precheck.error);

    const now = this.now();
    let person: BudgetPerson | null;
    if ("personId" in request.target) {
      person = this.deps.people.findById(request.target.personId);
      if (!person) return fail("person_not_found");
    } else {
      const target = resolveAdjustmentTarget({
        memberships: request.target.memberships,
        requestedSubsidiaryId: request.target.requestedSubsidiaryId,
      });
      if (!target.ok) return fail(target.error, target.candidates);
      person = this.deps.people.ensure({
        subsidiaryId: target.subsidiaryId,
        platform: request.target.platform,
        platformUserId: request.target.platformUserId,
      }, request.target.displayName ?? "", now);
    }

    let failure: AdjustmentError | null = null;
    const entry = this.deps.ledger.adjust({
      personId: person.id,
      actor: request.actor.id,
      now,
      decide: (rewardBalance) => {
        const decision = decideAdjustment({
          actorAuthorized: request.actor.authorized,
          tokens: request.tokens,
          reason: request.reason,
          rewardBalance,
        });
        if (!decision.ok) {
          failure = decision.error;
          return null;
        }
        return { applied: decision.applied, reason: decision.reason };
      },
    });
    if (!entry) return fail(failure ?? "nothing_to_reduce");
    return { ok: true, person, entry, rewardBalance: this.deps.ledger.balance(person.id) };
  }
}
