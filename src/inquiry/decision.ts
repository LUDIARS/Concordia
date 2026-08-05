import type { GeniusCard } from "./genius-client.js";

export type InquiryCategory = "タスク" | "パートタイマー" | "設計" | "権限";
export type InquiryDecision = "proceed" | "ask_human" | "self_judge";

const categories: Record<InquiryCategory, string[]> = {
  "タスク": ["タスク判断"],
  "パートタイマー": ["タスク判断", "稼働判断"],
  "設計": ["設計判断"],
  "権限": ["権限判断"],
};

export function isInquiryCategory(value: string): value is InquiryCategory {
  // `in` は prototype chain も見るため "toString" / "constructor" が語彙として
  // 通ってしまう。 自前の key だけを見て未知カテゴリを確実に 400 に落とす。
  return Object.prototype.hasOwnProperty.call(categories, value);
}

export function geniusCategories(category: InquiryCategory): string[] {
  return categories[category];
}

export function decideInquiry(cards: readonly GeniusCard[], scoreMin: number): InquiryDecision {
  const accepted = cards.filter((card) => card.score >= scoreMin);
  if (accepted.length === 0) return "self_judge";
  return accepted.some(needsHuman) ? "ask_human" : "proceed";
}

function needsHuman(card: GeniusCard): boolean {
  return [card.domain, ...(card.tags ?? [])].some((value) => /人間|権限|approval|human/i.test(value ?? ""));
}
