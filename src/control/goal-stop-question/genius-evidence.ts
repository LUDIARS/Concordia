/**
 * ゴールを止める質問を Genius (neco の判断カード) で判断できるかの門 (spec/feature/goal-stop-question-guard.md)。
 *
 * 背景 (2026-11-16 neco): 「自動回答は Genius が判断可能なものだけ判断する」。
 * Haiku の分類だけで「誰を招待するか」「どちらのツールにするか」のような人にしか決められない質問にも
 * 答えていたため、判断の根拠を Genius のカードに限る。
 *
 * - Genius が不在・失敗 → 答えない (genius_unavailable)
 * - 採用スコア以上のカードが無い → 答えない (no_precedent)
 * - 人間判断・権限を示すカードがある → 答えない (needs_human)。判定は inquiry と同じ decideInquiry。
 *
 * @implements SPEC-GOAL-STOP-Q-05
 */

import type { GeniusCard, GeniusClient } from "../../inquiry/genius-client.js";
import { decideInquiry, geniusCategories } from "../../inquiry/decision.js";
import type { AskedQuestion } from "./prefilter.js";

/** ゴールを止める質問は手順の判断と設計の判断の両方がありうるので、両カテゴリを引く。 */
export const GOAL_STOP_GENIUS_CATEGORIES = [...geniusCategories("タスク"), ...geniusCategories("設計")];

/** 判断に渡すカードの上限 (プロンプトの量を抑える)。 */
const MAX_CARDS = 5;

export type GeniusEvidence =
  | { ok: true; cards: GeniusCard[] }
  | { ok: false; reason: "genius_unavailable" | "no_precedent" | "needs_human" };

/** Genius の応答を「答えてよい根拠」に絞る (純関数)。 */
export function gateGeniusCards(cards: readonly GeniusCard[] | null, scoreMin: number): GeniusEvidence {
  if (cards === null) return { ok: false, reason: "genius_unavailable" };
  const decision = decideInquiry(cards, scoreMin);
  if (decision === "self_judge") return { ok: false, reason: "no_precedent" };
  if (decision === "ask_human") return { ok: false, reason: "needs_human" };
  const accepted = cards
    .filter((card) => card.score >= scoreMin)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CARDS);
  return { ok: true, cards: accepted };
}

export function geniusQueryText(asked: AskedQuestion, instructions: string[]): string {
  return [
    `[タスク] セッションの質問: ${asked.question}`,
    asked.options.length ? `選択肢: ${asked.options.join(" / ")}` : "",
    instructions.length ? `直近の指示: ${instructions[instructions.length - 1]}` : "",
  ].filter(Boolean).join("\n");
}

export type GeniusEvidenceLookup = (asked: AskedQuestion, instructions: string[]) => Promise<GeniusEvidence>;

/** Genius を引いて門を通す。失敗は不在扱い (答えない)。 */
export function geniusEvidenceLookup(genius: GeniusClient, scoreMin: () => number): GeniusEvidenceLookup {
  return async (asked, instructions) => {
    const cards = await genius
      .query({ text: geniusQueryText(asked, instructions), categories: GOAL_STOP_GENIUS_CATEGORIES, k: 8 })
      .catch(() => null);
    return gateGeniusCards(cards, scoreMin());
  };
}
