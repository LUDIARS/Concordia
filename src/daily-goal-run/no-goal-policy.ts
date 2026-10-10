/**
 * 「目標なし」の宣言の判定 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 目標を投稿する (目標なし) / CC-DG-INV-11
 *
 * 前後の空白・句読点・「です」等を除いて「目標なし」と一致するときだけ目標なしとする。
 * 「目標なしで◯◯をやる」のような文は目標なしではない (通常の投稿として読む)。
 */

const NO_GOAL_WORDS = new Set(["目標なし", "目標無し"]);
const EDGE_PUNCTUATION = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
const POLITE_SUFFIX = /(です|でした|とします|にします|で)$/;

export function isNoGoalPost(text: string): boolean {
  let value = text.normalize("NFKC").replace(/\s+/g, "").replace(EDGE_PUNCTUATION, "");
  for (let i = 0; i < 3 && POLITE_SUFFIX.test(value); i++) {
    value = value.replace(POLITE_SUFFIX, "").replace(EDGE_PUNCTUATION, "");
  }
  return NO_GOAL_WORDS.has(value);
}
