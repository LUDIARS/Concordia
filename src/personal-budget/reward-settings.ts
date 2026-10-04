/**
 * 報奨の加算量の設定キーと既定値 (spec/feature/personal-ai-budget.md §5 の提案値)。
 *
 * 設定レジストリ (configuration) と報奨の判断の両方がここを読む。 依存を持たない葉にしておき、
 * 設定定義から業務判断のモジュールを引き込まない。
 *
 * @implements SPEC-PBUDGET-REWARD
 */

export const REWARD_SETTINGS = {
  "bounty.s1": { key: "personal_budget.reward.bounty.s1", defaultTokens: 2_000_000 },
  "bounty.s2": { key: "personal_budget.reward.bounty.s2", defaultTokens: 1_000_000 },
  "bounty.s3": { key: "personal_budget.reward.bounty.s3", defaultTokens: 500_000 },
  "bounty.s4": { key: "personal_budget.reward.bounty.s4", defaultTokens: 100_000 },
  tabula: { key: "personal_budget.reward.tabula", defaultTokens: 300_000 },
} as const;

/** 加算量の段。 */
export type RewardTier = keyof typeof REWARD_SETTINGS;
