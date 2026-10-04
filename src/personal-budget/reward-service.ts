/**
 * 報奨の port (use case)。 他ドメイン (バグバウンティ・技術相談の公開) は「この根拠でこの個人へ」と
 * 依頼するだけで、 加算量と一意性はここが決める。 他ドメインから台帳を直接書かせない。
 *
 * 本社の調整 (`manual`) は adjustment-service が持つ。 付与したら本人への通知を待ち行列に置き、
 * 届かなくても付与は取り消さない (CC-INV-06)。 付けなかった理由は記録する (CC-PBUDGET-INV-07)。
 *
 * @implements SPEC-PBUDGET-REWARD
 * @implements spec/feature/personal-ai-budget.md §4 / §10
 */

import { resolveBudgetPerson } from "./person-resolution.js";
import type { LedgerEntry, LedgerStore, PeopleStore } from "./ports.js";
import {
  decideReward,
  REWARD_SETTINGS,
  REWARD_SKIP_LABEL,
  revokeTokens,
  rewardTier,
  rewardTokens,
  type AutomaticRewardKind,
  type RewardSkipReason,
} from "./reward-policy.js";
import type { BountySeverity, BudgetPlatform } from "./types.js";

export interface RewardRecipient {
  subsidiaryId: string | null;
  platform: BudgetPlatform | null;
  platformUserId: string | null;
  displayName?: string;
}

export interface RewardRequest {
  kind: AutomaticRewardKind;
  /** 根拠 (バグ報告の id、 公開候補の id)。 */
  sourceRef: string;
  recipient: RewardRecipient;
  /** `bounty` の加算量の段。 */
  severity?: BountySeverity | null;
}

export type RewardOutcome =
  | { status: "granted"; entry: LedgerEntry }
  | { status: "existing"; entry: LedgerEntry }
  | { status: "skipped"; reason: RewardSkipReason; detail: string };

export type RevokeOutcome =
  | { status: "revoked"; entry: LedgerEntry }
  | { status: "existing"; entry: LedgerEntry }
  | { status: "not_granted" };

/** 他ドメインが報奨を依頼する port。 */
export interface PersonalBudgetRewardPort {
  requestReward(request: RewardRequest): RewardOutcome;
  revokeReward(request: { kind: AutomaticRewardKind; sourceRef: string; reason: string }): RevokeOutcome;
}

export interface RewardServiceDeps {
  people: PeopleStore;
  ledger: LedgerStore;
  /** 設定 `personal_budget.reward.*` の生の値。 未設定なら null。 */
  readSetting: (key: string) => string | null;
  now?: () => number;
  /** 付けなかった理由の記録。 残高や個人の中身は渡さない。 */
  log?: { info: (message: string) => void };
}

export class PersonalBudgetRewards implements PersonalBudgetRewardPort {
  private readonly now: () => number;

  constructor(private readonly deps: RewardServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  requestReward(request: RewardRequest): RewardOutcome {
    const recipient = resolveBudgetPerson(request.recipient);
    const tier = rewardTier(request.kind, request.severity ?? null);
    const tokens = tier ? rewardTokens(tier, this.deps.readSetting(REWARD_SETTINGS[tier].key)) : null;
    const existing = this.deps.ledger.findBySource("grant", request.kind, request.sourceRef);
    const decision = decideReward({
      kind: request.kind,
      sourceRef: request.sourceRef,
      recipient,
      tokens,
      alreadyGranted: existing ? existing.tokens : null,
    });
    if (decision.action === "existing") return { status: "existing", entry: existing! };
    if (decision.action === "skip") {
      const detail = REWARD_SKIP_LABEL[decision.reason];
      this.deps.log?.info(`personal budget reward skipped kind=${request.kind} reason=${decision.reason}`);
      return { status: "skipped", reason: decision.reason, detail };
    }
    const now = this.now();
    const person = this.deps.people.ensure(decision.identity, request.recipient.displayName ?? "", now);
    // 競合した再送は台帳の一意制約で同じ行に収束する (CC-PBUDGET-INV-04)。
    const granted = this.deps.ledger.grant({
      personId: person.id, kind: request.kind, sourceRef: request.sourceRef, tokens: decision.tokens, now,
    });
    return granted.created ? { status: "granted", entry: granted.entry } : { status: "existing", entry: granted.entry };
  }

  revokeReward(request: { kind: AutomaticRewardKind; sourceRef: string; reason: string }): RevokeOutcome {
    const result = this.deps.ledger.revoke({
      kind: request.kind,
      sourceRef: request.sourceRef,
      reason: request.reason.trim().slice(0, 500),
      now: this.now(),
      decide: revokeTokens,
    });
    if (!result) return { status: "not_granted" };
    return result.created ? { status: "revoked", entry: result.entry } : { status: "existing", entry: result.entry };
  }
}
