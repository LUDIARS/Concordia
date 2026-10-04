/**
 * 個人の AI 予算で共有する語彙 (spec/feature/personal-ai-budget.md §1)。
 *
 * 個人は「会社・プラットフォーム・プラットフォームのユーザー id」の組で識別する (依頼者メモと同じ組)。
 * 本社は会社を持たない (subsidiaryId = null) ので、 個人の予算の対象にならない (CC-PBUDGET-INV-07)。
 *
 * @implements spec/feature/personal-ai-budget.md §1
 */

export type BudgetPlatform = "discord" | "slack";

/** 子会社に所属する 1 人。 */
export interface PersonIdentity {
  subsidiaryId: string;
  platform: BudgetPlatform;
  platformUserId: string;
}

/** 台帳の種別。 トークン数は報酬分の増減 (符号付き) で持つ。 */
export type LedgerEntryType = "grant" | "debit" | "revoke" | "manual";

/** 報奨の種類 (§4)。 */
export type RewardKind = "bounty" | "tabula" | "manual";

/** バグ報告の重大度 (加算量の段、 §5)。 */
export type BountySeverity = "s1" | "s2" | "s3" | "s4";

/** 調整・報奨 1 件で動かせる上限。 桁あふれと入力ミスの歯止め。 */
export const MAX_TOKENS_PER_ENTRY = 1_000_000_000;

/** epoch(ms) → ローカル時刻の月 "YYYY-MM"。 月間分は月初 (ローカル時刻) に戻る。 */
export function localMonth(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
