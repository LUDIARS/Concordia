/**
 * hotfix の 1 日の上限の設定キーと既定値 (spec/feature/bug-bounty.md §6 §10)。
 *
 * 設定レジストリ (configuration) と hotfix の判断の両方がここを読む。 依存を持たない葉にしておき、
 * 設定定義から業務判断のモジュールを引き込まない。
 *
 * @implements SPEC-BOUNTY-HOTFIX
 */

export const BOUNTY_HOTFIX_DAILY_LIMIT_KEY = "bounty.hotfix_daily_limit";
export const DEFAULT_BOUNTY_HOTFIX_DAILY_LIMIT = 5;
