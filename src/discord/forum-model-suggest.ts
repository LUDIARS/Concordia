/**
 * Session forum の起動モデル / Effort を機械的にサジェストする (2026-09-03 neco 指示)。
 *
 * LLM には頼らず、投稿本文の語彙と rate-limit 残量だけで決める:
 *  - 実装・修正 → Opus (Claude 系) または Sol mid (Codex 系)
 *  - 設計・レビュー → Fable または Opus (常に Claude 系。 Fable は使用量ゲート付き)
 *  - 雑用 → Sonnet (Claude 系) または Terra (Codex 系)
 *
 * Claude 系 / Codex 系の選択は「残りコスト比」= 週間枠の残量 (%) ÷ リセットまでの残り日数
 * で、比が大きい (= 1 日あたりに使える余裕が多い) 方を採る。 Fable は「Fable 使用量 < 70%
 * かつ 週間使用量 > Fable 使用量」のときだけ優先し、使用量が取れなければ Opus に倒す
 * (上限切れの巻き添えで起動直後に落ちる方が痛い)。
 *
 * 結果は質問カードの初期選択 (サジェスト) であり、人間が選び直せる。
 *
 * @implements spec/feature/subsidiary-delegation.md §3.1
 */

import type { ForumEffort, ForumModelChoice, ForumModelNick } from "./forum-spawn.js";

/** 投稿の作業種別。 語彙照合だけで決める (機械的でよい、neco 指示)。 */
export type ForumTaskKind = "implementation" | "design_review" | "chore";
export type ForumProviderFamily = "claude" | "codex";

/** 週間枠 1 本ぶんの残量。 `usedPct` は 0-100 の使用率、 `resetAtSec` は不明なら null。 */
export interface WeeklyQuotaWindow {
  usedPct: number | null;
  resetAtSec: number | null;
}

export interface ForumModelSuggestionInput {
  title: string;
  body: string;
  choices: readonly ForumModelChoice[];
  codexWeekly: WeeklyQuotaWindow | null;
  claudeWeekly: WeeklyQuotaWindow | null;
  /** Fable 単独の週間使用率 (%)。 取れなければ null = Fable を選ばない。 */
  fableUsedPct: number | null;
  nowSec: number;
}

export interface ForumModelSuggestion {
  nick: ForumModelNick;
  effort: ForumEffort;
  kind: ForumTaskKind;
  family: ForumProviderFamily;
  /** カードに添える短い根拠 (人間が選び直す判断材料)。 */
  reason: string;
}

/** Fable を優先するための使用率上限 (%)。 */
export const FABLE_USAGE_CEILING_PCT = 70;
/** リセット時刻が不明 / 過ぎているときに使う残り日数の下限 (0 除算と極端な比を避ける)。 */
const MIN_REMAINING_DAYS = 0.25;
const DEFAULT_REMAINING_DAYS = 7;

const DESIGN_REVIEW_SIGNALS = [
  "設計", "レビュー", "review", "design", "仕様", "spec", "方針", "調査", "検討", "比較",
  "アーキテクチャ", "architecture", "監査", "audit",
];
const CHORE_SIGNALS = [
  "雑用", "掃除", "整理", "rename", "改名", "typo", "誤字", "バージョン", "version bump",
  "依存更新", "deps", "dependabot", "ドキュメント", "docs", "readme", "メモ", "登録", "棚卸",
  "リスト化", "一覧", "コピー", "移動",
];
const IMPLEMENTATION_SIGNALS = [
  "実装", "修正", "fix", "implement", "bug", "不具合", "追加", "変更", "対応", "直して",
  "作って", "機能", "feature", "テスト", "test", "エラー", "error", "壊れ",
];

/** 投稿本文の語彙で作業種別を決める。 設計・レビュー > 雑用 > 実装・修正 の順で判定し、無印は実装扱い。 */
export function classifyForumTaskKind(title: string, body: string): ForumTaskKind {
  const haystack = `${title}\n${body}`.toLowerCase();
  if (DESIGN_REVIEW_SIGNALS.some((signal) => haystack.includes(signal))) return "design_review";
  if (CHORE_SIGNALS.some((signal) => haystack.includes(signal))) return "chore";
  if (IMPLEMENTATION_SIGNALS.some((signal) => haystack.includes(signal))) return "implementation";
  return "implementation";
}

/**
 * 残りコスト比 = 残量% ÷ 残り日数。 使用率が取れなければ null (比較不能)。
 * リセット時刻が無い / 既に過ぎているときは既定の 7 日で割る。
 */
export function remainingQuotaRatio(window: WeeklyQuotaWindow | null, nowSec: number): number | null {
  if (!window || window.usedPct === null || !Number.isFinite(window.usedPct)) return null;
  const remainPct = Math.max(0, Math.min(100, 100 - window.usedPct));
  const days = window.resetAtSec !== null && window.resetAtSec > nowSec
    ? Math.max(MIN_REMAINING_DAYS, (window.resetAtSec - nowSec) / 86_400)
    : DEFAULT_REMAINING_DAYS;
  return remainPct / days;
}

/**
 * Claude 系 / Codex 系のどちらを使うか。 比が大きい方。 片方しか取れなければ取れた方、
 * 両方取れなければ Claude (既存 pickAvailableForumProvider と同じ既定)。 同率は Claude。
 */
export function pickProviderFamilyByCostRatio(input: {
  codexWeekly: WeeklyQuotaWindow | null;
  claudeWeekly: WeeklyQuotaWindow | null;
  nowSec: number;
}): { family: ForumProviderFamily; codexRatio: number | null; claudeRatio: number | null } {
  const codexRatio = remainingQuotaRatio(input.codexWeekly, input.nowSec);
  const claudeRatio = remainingQuotaRatio(input.claudeWeekly, input.nowSec);
  if (codexRatio === null && claudeRatio === null) return { family: "claude", codexRatio, claudeRatio };
  if (codexRatio === null) return { family: "claude", codexRatio, claudeRatio };
  if (claudeRatio === null) return { family: "codex", codexRatio, claudeRatio };
  return { family: codexRatio > claudeRatio ? "codex" : "claude", codexRatio, claudeRatio };
}

/** Fable 優先ゲート: Fable 使用量 < 70% かつ 週間使用量 > Fable 使用量。 どちらかが取れなければ不可。 */
export function isFablePreferred(fableUsedPct: number | null, claudeWeeklyUsedPct: number | null): boolean {
  if (fableUsedPct === null || claudeWeeklyUsedPct === null) return false;
  if (!Number.isFinite(fableUsedPct) || !Number.isFinite(claudeWeeklyUsedPct)) return false;
  return fableUsedPct < FABLE_USAGE_CEILING_PCT && claudeWeeklyUsedPct > fableUsedPct;
}

/** 種別 × 系統 → 候補 nickname の優先順 (先頭から、候補に無ければ次)。 */
function candidateNicks(kind: ForumTaskKind, family: ForumProviderFamily, fablePreferred: boolean): ForumModelNick[] {
  // Fable は使用量ゲートを通った場合だけ候補に入れる。使用量不明時に Opus が無いからと
  // Fable へ倒すと「上限切れを避ける」というゲートの目的を迂回してしまう。
  if (kind === "design_review") return fablePreferred ? ["fable", "opus"] : ["opus"];
  if (kind === "chore") return family === "codex" ? ["terra", "sonnet"] : ["sonnet", "terra"];
  return family === "codex" ? ["sol", "opus"] : ["opus", "sol"];
}

/** 種別ごとの effort。 実装・修正は mid (Sol mid の指示に合わせる)、設計・レビューは high、雑用は low。 */
export function effortForTaskKind(kind: ForumTaskKind): ForumEffort {
  if (kind === "design_review") return "high";
  if (kind === "chore") return "low";
  return "medium";
}

const KIND_LABEL: Record<ForumTaskKind, string> = {
  implementation: "実装・修正",
  design_review: "設計・レビュー",
  chore: "雑用",
};

/**
 * サジェストを 1 件返す。 候補 (choices) に該当 nickname が無ければ null (カードは無印で出す)。
 */
export function suggestForumModel(input: ForumModelSuggestionInput): ForumModelSuggestion | null {
  const kind = classifyForumTaskKind(input.title, input.body);
  const picked = pickProviderFamilyByCostRatio({
    codexWeekly: input.codexWeekly,
    claudeWeekly: input.claudeWeekly,
    nowSec: input.nowSec,
  });
  const fablePreferred = isFablePreferred(input.fableUsedPct, input.claudeWeekly?.usedPct ?? null);
  // 設計・レビューは常に Claude 系 (Fable / Opus)。
  const preferredFamily: ForumProviderFamily = kind === "design_review" ? "claude" : picked.family;
  const choice = candidateNicks(kind, preferredFamily, fablePreferred)
    .map((candidate) => input.choices.find((available) => available.nick === candidate))
    .find((available): available is ForumModelChoice => available !== undefined);
  if (!choice) return null;
  // 優先系統の候補が無く次点へ倒れた場合、返す family も実際の provider に合わせる。
  const family: ForumProviderFamily = choice.provider === "codex" ? "codex" : "claude";
  const effort = effortForTaskKind(kind);
  const ratioText = [
    picked.claudeRatio !== null ? `Claude ${picked.claudeRatio.toFixed(1)}` : null,
    picked.codexRatio !== null ? `Codex ${picked.codexRatio.toFixed(1)}` : null,
  ].filter((part): part is string => part !== null).join(" / ");
  const fableText = kind === "design_review"
    ? (fablePreferred ? "Fable 枠あり" : input.fableUsedPct === null ? "Fable 使用量 不明" : "Fable 枠なし")
    : null;
  const reason = [
    KIND_LABEL[kind],
    ratioText ? `残枠比 ${ratioText}` : "残枠 不明",
    fableText,
  ].filter((part): part is string => part !== null).join(" / ");
  return { nick: choice.nick, effort, kind, family, reason };
}
