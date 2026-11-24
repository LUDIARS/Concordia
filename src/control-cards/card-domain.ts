/**
 * 管制カードの業務用語 (spec/feature/control-cards.md)。型と定数だけを置く。
 * カードの解決の正本は出所で、カードは出所の参照・捌き・催促の予定だけを持つ (CC-V5-INV-02)。
 *
 * @implements spec/feature/control-cards.md — 業務用語
 */

export const CARD_SOURCE_KINDS = [
  "ask-card",
  "inquiry-ask-human",
  "confirm-pending",
  "director-blocked",
  "design-plan-approval",
  "github-issue-approval",
  "human-wait",
  "human-command",
  "management-waiting-human",
  "session-unresponsive",
] as const;
export type CardSourceKind = (typeof CARD_SOURCE_KINDS)[number];

export type CardKind = "human_action" | "human_judgment";
export const CARD_PRIORITIES = ["high", "normal", "low"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];
export type CardState = "open" | "closed";

/** 出所ごとの種別。アクション (人間が手を動かす) か判断 (人間が決める) か。 */
export const CARD_KIND_OF: Record<CardSourceKind, CardKind> = {
  "ask-card": "human_judgment",
  "inquiry-ask-human": "human_judgment",
  "confirm-pending": "human_judgment",
  "director-blocked": "human_judgment",
  "design-plan-approval": "human_judgment",
  "github-issue-approval": "human_judgment",
  "human-wait": "human_judgment",
  "human-command": "human_action",
  "management-waiting-human": "human_judgment",
  "session-unresponsive": "human_action",
};

/**
 * カードが正本の出所 (実装メモ 6)。人間依頼は DB に記録が無く、カードが正本になる。
 * これ以外はカード側から閉じない (CC-V5-INV-02 / 03)。
 */
export const CARD_OWNED_SOURCES: ReadonlySet<CardSourceKind> = new Set(["human-command"]);

export interface ControlCard {
  id: string;
  source_kind: CardSourceKind;
  source_key: string;
  card_kind: CardKind;
  summary: string;
  session_id: string | null;
  project: string | null;
  link: string | null;
  state: CardState;
  raised_at: number;
  closed_at: number | null;
  close_reason: string | null;
  priority: CardPriority;
  assignee: string | null;
  remind_at: number | null;
  reminder_text: string | null;
  card_group: string | null;
  triaged_by: string | null;
  triaged_at: number | null;
  created_at: number;
  updated_at: number;
}

/** 出所で観測した未解決の 1 件。 */
export interface CardSourceItem {
  source_kind: CardSourceKind;
  source_key: string;
  summary: string;
  raised_at: number;
  session_id: string | null;
  project: string | null;
  link: string | null;
}

/** 捌きで変えられる列 (CC-V5-INV-04)。 */
export interface CardTriagePatch {
  priority?: CardPriority;
  assignee?: string | null;
  remind_at?: number | null;
  reminder_text?: string | null;
  card_group?: string | null;
}

export const CARD_SUMMARY_MAX_CHARS = 300;
/** dots が応答しない間の既定の催促 (作成から 24 時間後、§3)。 */
export const DEFAULT_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/** 一覧に出す長さに詰める (コードポイント単位、空白を潰す)。 */
export function clipText(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}
