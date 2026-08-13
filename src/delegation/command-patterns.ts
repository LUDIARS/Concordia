/**
 * Genius の command-pattern カード (定型作業の具体的コマンド列) を委託プロンプトへ
 * push 注入する (spec/feature/genius-command-patterns.md)。
 *
 * Skill (pull 型) は弱いモデル (Terra / Sonnet 等) が呼ばずに処理がばらつくため、
 * invoke 時に Cc 側で task 文面を照会し、一致した手順を最初から渡す (push 型)。
 * Genius 不在・低スコア・カテゴリ未登録はすべて黙って注入なし (fail-soft) —
 * 委託の成立そのものを Genius に依存させない。
 */

import type { GeniusCard, GeniusClient } from "../inquiry/genius-client.js";

/** Genius 側の統制語彙 (card_categories) に登録済みのカテゴリ名。 */
export const COMMAND_PATTERN_CATEGORY = "command-pattern";

/** 照会件数。採用は上位 MAX_PATTERNS 件まで (プロンプト肥大防止)。 */
const QUERY_K = 4;
const MAX_PATTERNS = 2;
/** クエリに使う task 文面の上限 (embed コストとノイズの抑制)。 */
const MAX_QUERY_CHARS = 2000;
/** 注入ブロック全体の上限 (プロンプト肥大防止)。超過分のカードは落とす。 */
const MAX_BLOCK_CHARS = 6000;

export interface CommandPatternDeps {
  genius: GeniusClient;
  /** 採用する最低スコア (inquiry と同じ cfg.inquiryScoreMin を渡す)。 */
  scoreMin: number;
}

/**
 * task 文面に一致する command-pattern カードを照会し、委託プロンプトへ差し込む
 * ブロックを組み立てる。一致なし / Genius 不在は null (注入しない)。
 */
export async function buildCommandPatternBlock(
  deps: CommandPatternDeps,
  taskText: string,
): Promise<string | null> {
  const text = taskText.trim().slice(0, MAX_QUERY_CHARS);
  if (!text) return null;
  const cards = await deps.genius.query({
    text,
    categories: [COMMAND_PATTERN_CATEGORY],
    k: QUERY_K,
  });
  if (!cards || cards.length === 0) return null;
  const matched = cards
    .filter((card) =>
      card.score >= deps.scoreMin &&
      Boolean(card.judgment?.trim()) &&
      (card.category === undefined || card.category === null || card.category === COMMAND_PATTERN_CATEGORY)
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_PATTERNS);
  if (matched.length === 0) return null;

  const preamble = [
    "## コマンドパターン (Genius)",
    "",
    "この依頼に一致した定型手順です。該当する作業では **ここに書かれたコマンド・手順を",
    "そのまま使い**、自前の代替手順を組み立てないでください (処理のばらつき防止)。",
    "現在の状況と明らかに矛盾する場合は、実行せず矛盾点を報告して指示を仰いでください。",
  ].join("\n");
  let block = preamble;
  let included = 0;
  for (const card of matched) {
    const section = formatCard(card);
    if (!section) continue;
    const candidate = `${block}\n\n${section}`;
    if (candidate.length > MAX_BLOCK_CHARS) continue;
    block = candidate;
    included += 1;
  }
  return included > 0 ? block : null;
}

function formatCard(card: GeniusCard): string | null {
  const judgment = card.judgment?.trim();
  if (!judgment) return null;
  const situation = (card.situation ?? card.title ?? "").trim();
  const parts = [`### ${situation || "(場面の記述なし)"}`, "", judgment];
  const rationale = card.rationale?.trim();
  if (rationale) parts.push("", `補足: ${rationale}`);
  return parts.join("\n");
}
