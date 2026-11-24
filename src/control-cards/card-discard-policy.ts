/**
 * 判断カードの破棄の判定 (純関数、実装メモ 14、CC-V5-INV-08)。
 * 判断カードは持ち主のセッションが active のときだけ開いたまま置き、そうでなければ discarded にする。
 * セッションに属さない判断と、人間のアクションのカードは対象外。持ち主を判定する材料が読めない巡回では何も捨てない。
 *
 * @implements spec/feature/control-cards.md — 破棄 (実装メモ 14)
 */
import {
  CARD_KIND_OF,
  type CardDiscardReason,
  type CardSourceItem,
  type CardSourceKind,
  type ControlCard,
} from "./card-domain.js";

/** セッションと無関係な人間の判断。持ち主のセッションで捨てない。 */
export const SESSIONLESS_JUDGMENT_SOURCES: ReadonlySet<CardSourceKind> = new Set([
  "management-waiting-human",
  "director-blocked",
  "github-issue-approval",
]);

/** 持ち主の判定に使う材料 (巡回ごとに 1 回読む)。 */
export interface CardOwnership {
  /** sessions.status = 'active' のセッション。 */
  activeSessions: ReadonlySet<string>;
  /** session_id の無い confirm-pending の出所キー → PR を出した Cc セッション。引けなければ null。 */
  confirmPendingOwner: (sourceKey: string) => string | null;
}

export type CardDiscardDecision = { kind: "keep" } | { kind: "discard"; reason: CardDiscardReason };

const KEEP: CardDiscardDecision = { kind: "keep" };

function ownedBy(sessionId: string | null, ownership: CardOwnership): CardDiscardDecision {
  if (!sessionId) return { kind: "discard", reason: "session_unresolved" };
  return ownership.activeSessions.has(sessionId) ? KEEP : { kind: "discard", reason: "session_inactive" };
}

export function decideCardDiscard(
  card: Pick<ControlCard | CardSourceItem, "source_kind" | "source_key" | "session_id">,
  ownership: CardOwnership,
): CardDiscardDecision {
  if (CARD_KIND_OF[card.source_kind] !== "human_judgment") return KEEP;
  if (SESSIONLESS_JUDGMENT_SOURCES.has(card.source_kind)) return KEEP;
  if (card.session_id) return ownedBy(card.session_id, ownership);
  // セッションの無い起動・昇格承認は、その PR を出した Cc セッションの判断として扱う。
  if (card.source_kind === "confirm-pending") return ownedBy(ownership.confirmPendingOwner(card.source_key), ownership);
  // その他のセッションの無い判断は持ち主を判定できないので残す。
  return KEEP;
}

export interface CardDiscardPlan {
  /** 開いているカードのうち捨てるもの。 */
  discard: Array<{ id: string; reason: CardDiscardReason }>;
  /** 作る出所のうち、最初から discarded で作るもの。 */
  createDiscarded: Array<{ item: CardSourceItem; reason: CardDiscardReason }>;
  /** 作る出所のうち、開いたカードとして作るもの。 */
  createOpen: CardSourceItem[];
}

export function planCardDiscards(input: {
  openCards: readonly ControlCard[];
  create: readonly CardSourceItem[];
  /** 同じ巡回で閉じるカード (閉じる方を優先し、捨てない)。 */
  closing: ReadonlySet<string>;
  /** 読めなかったら null。そのときは何も捨てない。 */
  ownership: CardOwnership | null;
}): CardDiscardPlan {
  const { ownership } = input;
  if (!ownership) return { discard: [], createDiscarded: [], createOpen: [...input.create] };
  const plan: CardDiscardPlan = { discard: [], createDiscarded: [], createOpen: [] };
  for (const card of input.openCards) {
    if (input.closing.has(card.id)) continue;
    const decision = decideCardDiscard(card, ownership);
    if (decision.kind === "discard") plan.discard.push({ id: card.id, reason: decision.reason });
  }
  for (const item of input.create) {
    const decision = decideCardDiscard(item, ownership);
    if (decision.kind === "discard") plan.createDiscarded.push({ item, reason: decision.reason });
    else plan.createOpen.push(item);
  }
  return plan;
}
