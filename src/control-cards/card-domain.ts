/**
 * 管制カードの業務用語 (spec/feature/control-cards.md)。型と定数だけを置く。
 * カードの解決の正本は出所で、カードは出所の参照・表示内容・捌き・催促の予定を持つ (CC-V5-INV-02)。
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
  "kaizen-proposal",
  "desk-project-selection",
  "desk-routing-issue",
] as const;
export type CardSourceKind = (typeof CARD_SOURCE_KINDS)[number];

export type CardKind = "human_action" | "human_judgment";
export const CARD_PRIORITIES = ["high", "normal", "low"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];
/** discarded: 持ち主のセッションが active でない判断カード (実装メモ 14、CC-V5-INV-08)。再び開かない。 */
export type CardState = "open" | "closed" | "discarded";
export const CARD_DISCARD_REASONS = ["session_inactive", "session_unresolved"] as const;
export type CardDiscardReason = (typeof CARD_DISCARD_REASONS)[number];

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
  "kaizen-proposal": "human_judgment",
  "desk-project-selection": "human_judgment",
  "desk-routing-issue": "human_action",
};

/**
 * 人間依頼とカイゼンの判断はカードが解決状態の正本になる。
 * これ以外はカード側から閉じない (CC-V5-INV-02 / 03)。
 */
export const CARD_OWNED_SOURCES: ReadonlySet<CardSourceKind> = new Set(["human-command", "kaizen-proposal"]);

export interface ControlCard {
  id: string;
  source_kind: CardSourceKind;
  source_key: string;
  card_kind: CardKind;
  summary: string;
  human_action: string | null;
  session_id: string | null;
  project: string | null;
  link: string | null;
  state: CardState;
  raised_at: number;
  closed_at: number | null;
  close_reason: string | null;
  discarded_at: number | null;
  discard_reason: CardDiscardReason | null;
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
  human_action?: string | null;
  raised_at: number;
  session_id: string | null;
  project: string | null;
  link: string | null;
}

/** 捌きで変えられる列 (CC-V5-INV-04)。 */
export interface CardTriagePatch {
  /** dots は空欄だけを補完できる。 */
  human_action?: string;
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
