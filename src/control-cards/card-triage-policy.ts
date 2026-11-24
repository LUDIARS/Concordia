/**
 * dots の捌き (指令ブリッジの card_triage) の業務判断 (純関数)。
 * - 指令に載せるカードの要約と、指令を積むかの判定 (§3、実装メモ 7)
 * - dots の回答の検証。変えられるのは優先度・担当者・催促時刻・催促文・まとめ先だけ。
 *   不明なカード ID・閉じたカード・範囲外の値は捨てる (CC-V5-INV-04)。
 *
 * @implements spec/feature/control-cards.md — dots の捌き (CC-V5-INV-04)
 */
import { createHash } from "node:crypto";
import { CARD_PRIORITIES, clipText, type CardPriority, type CardTriagePatch, type ControlCard } from "./card-domain.js";

export const TRIAGE_MAX_CARDS = 20;
export const TRIAGE_SUMMARY_CHARS = 200;
export const TRIAGE_PARAMS_MAX_BYTES = 8000;
/** 指令を積む最短間隔 (§3)。 */
export const TRIAGE_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const REMINDER_TEXT_MAX_CHARS = 400;
const ASSIGNEE_MAX_CHARS = 100;
const GROUP_MAX_CHARS = 100;
/** dots が催促時刻に指定できる先の上限 (30 日)。 */
const REMIND_HORIZON_MS = 30 * 86_400_000;

const PRIORITY_ORDER: Record<CardPriority, number> = { high: 0, normal: 1, low: 2 };

export interface TriageCardSummary {
  card_id: string;
  kind: string;
  source: string;
  summary: string;
  project: string | null;
  age_minutes: number;
  priority: CardPriority;
  assignee: string | null;
  remind_at: string | null;
}

export interface TriageParams {
  cards: TriageCardSummary[];
  open_total: number;
  response_schema: string;
}

const RESPONSE_SCHEMA = "result.detail.cards[] = {card_id, priority: high|normal|low, assignee?, remind_at? (ISO 8601), reminder_text? (400 字まで), group?}";

/** 優先度の高い順・古い順に最大 20 件。本文・transcript は入れない (§3)。 */
export function buildTriageParams(openCards: readonly ControlCard[], nowMs: number): TriageParams {
  const ordered = [...openCards].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.raised_at - b.raised_at);
  let cards = ordered.slice(0, TRIAGE_MAX_CARDS).map((card): TriageCardSummary => ({
    card_id: card.id,
    kind: card.card_kind,
    source: card.source_kind,
    summary: clipText(card.summary, TRIAGE_SUMMARY_CHARS),
    project: card.project,
    age_minutes: Math.max(0, Math.floor((nowMs - card.raised_at) / 60_000)),
    priority: card.priority,
    assignee: card.assignee,
    remind_at: card.remind_at === null ? null : new Date(card.remind_at).toISOString(),
  }));
  // 8000 バイトの上限に収まるまで後ろから落とす。
  const params = (): TriageParams => ({ cards, open_total: openCards.length, response_schema: RESPONSE_SCHEMA });
  while (cards.length > 0 && Buffer.byteLength(JSON.stringify(params()), "utf8") > TRIAGE_PARAMS_MAX_BYTES) cards = cards.slice(0, -1);
  return params();
}

/** 開いているカードの集合と捌きに関わる内容の指紋。変わったときだけ指令を積む。 */
export function triageFingerprint(openCards: readonly ControlCard[]): string {
  const rows = [...openCards]
    .map((card) => [card.id, card.summary, card.priority, card.assignee ?? "", card.remind_at ?? ""].join("\u0001"))
    .sort();
  return createHash("sha256").update(rows.join("\u0002"), "utf8").digest("hex");
}

export interface TriageDispatchState {
  fingerprint: string | null;
  instruction_id: string | null;
  registered_at: number | null;
}

export type TriageDispatchDecision =
  | { kind: "register" }
  | { kind: "skip"; reason: "disabled" | "no_cards" | "unchanged" | "previous_unfinished" | "too_soon" };

/** 指令を積むか。前の指令が終わっていなければ積まない。終わったら最新の集合で積む (§3)。 */
export function decideTriageDispatch(input: {
  enabled: boolean;
  openCount: number;
  fingerprint: string;
  state: TriageDispatchState;
  /** 前の指令が終端 (done / failed) か。指令が無い・消えたなら true。 */
  previousFinished: boolean;
  nowMs: number;
}): TriageDispatchDecision {
  if (!input.enabled) return { kind: "skip", reason: "disabled" };
  if (input.openCount === 0) return { kind: "skip", reason: "no_cards" };
  if (input.state.fingerprint === input.fingerprint) return { kind: "skip", reason: "unchanged" };
  if (input.state.instruction_id && !input.previousFinished) return { kind: "skip", reason: "previous_unfinished" };
  if (input.state.registered_at !== null && input.nowMs - input.state.registered_at < TRIAGE_MIN_INTERVAL_MS) return { kind: "skip", reason: "too_soon" };
  return { kind: "register" };
}

export interface TriageApplication {
  apply: Array<{ cardId: string; patch: CardTriagePatch }>;
  dropped: Array<{ card_id: string | null; reason: string }>;
}

function optionalText(value: unknown, max: number): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).length > max ? false : trimmed;
}

/** dots の回答 (result.detail) を検証し、適用してよい捌きだけを返す (CC-V5-INV-04)。 */
export function validateTriageResult(detail: unknown, openCardIds: ReadonlySet<string>, nowMs: number): TriageApplication {
  const result: TriageApplication = { apply: [], dropped: [] };
  const cards = detail && typeof detail === "object" ? (detail as { cards?: unknown }).cards : undefined;
  if (!Array.isArray(cards)) {
    result.dropped.push({ card_id: null, reason: "detail.cards がありません" });
    return result;
  }
  const seen = new Set<string>();
  for (const entry of cards.slice(0, 100)) {
    if (!entry || typeof entry !== "object") { result.dropped.push({ card_id: null, reason: "形が違います" }); continue; }
    const row = entry as Record<string, unknown>;
    const cardId = typeof row.card_id === "string" ? row.card_id : null;
    if (!cardId || !openCardIds.has(cardId)) { result.dropped.push({ card_id: cardId, reason: "不明か閉じたカード" }); continue; }
    if (seen.has(cardId)) { result.dropped.push({ card_id: cardId, reason: "重複" }); continue; }
    seen.add(cardId);
    const patch: CardTriagePatch = {};
    if (row.priority !== undefined) {
      if (!CARD_PRIORITIES.includes(row.priority as CardPriority)) { result.dropped.push({ card_id: cardId, reason: "priority が範囲外" }); continue; }
      patch.priority = row.priority as CardPriority;
    }
    const assignee = optionalText(row.assignee, ASSIGNEE_MAX_CHARS);
    const reminderText = optionalText(row.reminder_text, REMINDER_TEXT_MAX_CHARS);
    const group = optionalText(row.group, GROUP_MAX_CHARS);
    if (assignee === false || reminderText === false || group === false) { result.dropped.push({ card_id: cardId, reason: "文字列が範囲外" }); continue; }
    if (assignee !== undefined) patch.assignee = assignee;
    if (reminderText !== undefined) patch.reminder_text = reminderText;
    if (group !== undefined) patch.card_group = group;
    if (row.remind_at !== undefined && row.remind_at !== null) {
      const at = typeof row.remind_at === "string" ? Date.parse(row.remind_at) : Number.NaN;
      if (!Number.isFinite(at) || at > nowMs + REMIND_HORIZON_MS) { result.dropped.push({ card_id: cardId, reason: "remind_at が範囲外" }); continue; }
      patch.remind_at = Math.max(at, nowMs);
    }
    if (Object.keys(patch).length === 0) { result.dropped.push({ card_id: cardId, reason: "変更がありません" }); continue; }
    result.apply.push({ cardId, patch });
  }
  return result;
}
