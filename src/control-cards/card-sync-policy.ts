/**
 * 出所の観測 → カードの作成・閉鎖の判定 (純関数)。
 * 閉じるのは出所を読めて、その出所に未解決として現れなかったときだけ (CC-V5-INV-03)。
 * 読めなかった出所のカードは開いたまま残す。
 *
 * @implements spec/feature/control-cards.md — 同期 (CC-V5-INV-02 / CC-V5-INV-03)
 */
import {
  CARD_OWNED_SOURCES,
  CARD_SUMMARY_MAX_CHARS,
  clipText,
  type CardSourceItem,
  type CardSourceKind,
  type ControlCard,
} from "./card-domain.js";

/** 出所 1 種類の読み取り結果。readable=false は「読めなかった」(未解決 0 件とは違う)。 */
export type SourceReading =
  | { kind: CardSourceKind; readable: true; items: CardSourceItem[] }
  | { kind: CardSourceKind; readable: false; error: string };

export interface CardSyncInput {
  readings: readonly SourceReading[];
  openCards: readonly ControlCard[];
  /** セッションが終わっているか。不明は null (閉じない)。 */
  sessionEnded: (sessionId: string) => boolean | null;
}

export interface CardSyncPlan {
  create: CardSourceItem[];
  /** 要旨・リンクが変わった開いているカード。 */
  refresh: Array<{ id: string; summary: string; link: string | null }>;
  close: Array<{ id: string; reason: string }>;
  unreadable: CardSourceKind[];
}

const identity = (kind: string, key: string) => `${kind}\u0000${key}`;

export function planCardSync(input: CardSyncInput): CardSyncPlan {
  const plan: CardSyncPlan = { create: [], refresh: [], close: [], unreadable: [] };
  const open = new Map(input.openCards.map((card) => [identity(card.source_kind, card.source_key), card]));
  const readable = new Set<CardSourceKind>();
  const seen = new Set<string>();

  for (const reading of input.readings) {
    if (!reading.readable) {
      plan.unreadable.push(reading.kind);
      continue;
    }
    readable.add(reading.kind);
    for (const raw of reading.items) {
      const item = { ...raw, summary: clipText(raw.summary, CARD_SUMMARY_MAX_CHARS) };
      const id = identity(item.source_kind, item.source_key);
      if (seen.has(id)) continue;
      seen.add(id);
      const card = open.get(id);
      if (!card) plan.create.push(item);
      else if (card.summary !== item.summary || card.link !== item.link) plan.refresh.push({ id: card.id, summary: item.summary, link: item.link });
    }
  }

  for (const card of input.openCards) {
    if (CARD_OWNED_SOURCES.has(card.source_kind)) {
      // カードが正本の出所は、人間の「済み」かセッション終了でだけ閉じる (実装メモ 6)。
      if (card.session_id && input.sessionEnded(card.session_id) === true) plan.close.push({ id: card.id, reason: "session_ended" });
      continue;
    }
    if (!readable.has(card.source_kind)) continue;
    if (!seen.has(identity(card.source_kind, card.source_key))) plan.close.push({ id: card.id, reason: "source_resolved" });
  }
  return plan;
}
