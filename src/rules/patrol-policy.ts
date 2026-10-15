/**
 * 巡回チャットの決定的な選択 (spec/feature/patrol-chat.md §6–§7).
 *
 * BT の Selector に相当する固定優先順位と、 その中の整数 score 付けを純関数で表す。
 * 入力は時刻・乱数 seed・観測だけで、 LLM を呼ばない (CC-PATROL-01)。
 *
 *   1. 停止 / 無効 / 予算        → stop
 *   2. 未処理の直接返信          → reply      (受信順、 最大 3 件をまとめる)
 *   3. 明示した service event    → event      (受信順)
 *   4. 条件を満たした無返信追投稿 → followup
 *   5. 定期素材 pick             → pick
 *   6. 候補なし                  → skip (理由付き)
 */

import type { Material } from "./material-types.js";
import { PATROL_HARD_CAPS, type FollowupConfig, type PatrolActionConfig } from "./patrol-config.js";

// ─── 乱数 ────────────────────────────────────────────────

/** seed 付き擬似乱数 (mulberry32)。 同じ seed なら同じ列を返す。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 次の定期実行時刻。 再起動で全 tick rule が同時発火しないよう rule ID から決まる jitter
 * (間隔の 10% 以内) を足す。 同じ rule・同じ起点なら毎回同じ値。
 */
export function computeNextDueAt(ruleId: string, tickSec: number, fromSec: number): number {
  const span = Math.max(1, Math.floor(tickSec / 10));
  return fromSec + tickSec + (hash32(ruleId) % span);
}

// ─── 停止条件 ────────────────────────────────────────────

export interface StopInput {
  runtimeDisabled: boolean;
  ruleEnabled: boolean;
  config: PatrolActionConfig;
  rootsToday: number;
  llmCallsToday: number;
}

/** 新規生成・送信を始めてはいけない理由。 無ければ null (CC-PATROL-06)。 */
export function stopReason(input: StopInput, needsRender: boolean): string | null {
  if (input.runtimeDisabled) return "rules disabled at runtime (admin/cost)";
  if (!input.ruleEnabled) return "rule disabled";
  if (needsRender && input.config.renderer === "oneshot" && input.llmCallsToday >= input.config.llm_limit_per_day) {
    return `llm budget reached (${input.llmCallsToday}/${input.config.llm_limit_per_day} today)`;
  }
  return null;
}

// ─── 素材選択 ────────────────────────────────────────────

export interface ScoredCandidate {
  itemId: string;
  score: number;
}

export interface MaterialPick {
  picked: Material | null;
  reason: string;
  candidateCount: number;
  scored: ScoredCandidate[];
}

export interface PickContext {
  nowMs: number;
  scopeKey: string;
  config: PatrolActionConfig;
  /** この rule が既に使った話題 (itemId)。 */
  usedItemIds: ReadonlySet<string>;
  random: () => number;
}

/**
 * 候補集合から 1 件を選ぶ。 鮮度・未使用・filter 一致を整数 score にし、 最高点の中から乱数で選ぶ。
 * 人気順 1 位への固定と、 選択のための LLM 呼出しをしない。
 */
export function pickMaterial(items: readonly Material[], ctx: PickContext): MaterialPick {
  const { filters } = ctx.config;
  const maxAgeMs = filters.max_age_sec * 1000;
  const eligible = items.filter((m) => {
    if (ctx.usedItemIds.has(m.itemId)) return false;
    if (!m.shareableTo.includes("*") && !m.shareableTo.includes(ctx.scopeKey)) return false;
    const age = ctx.nowMs - Date.parse(m.occurredAt);
    if (!Number.isFinite(age) || age > maxAgeMs) return false;
    if (filters.genres?.length && !(m.tags ?? []).some((t) => filters.genres!.includes(t))) return false;
    return true;
  });
  if (eligible.length === 0) {
    return {
      picked: null,
      reason: items.length === 0 ? "no material" : "no eligible material (used / stale / scope / filter)",
      candidateCount: 0,
      scored: [],
    };
  }
  const scored = eligible.map((m) => ({ m, score: scoreMaterial(m, ctx.nowMs, maxAgeMs, ctx.config) }));
  const top = Math.max(...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === top).sort((a, b) => a.m.itemId.localeCompare(b.m.itemId));
  const chosen = best[Math.floor(ctx.random() * best.length)] ?? best[0];
  return {
    picked: chosen.m,
    reason: `picked 1 of ${best.length} top-score (score ${top}) among ${eligible.length}`,
    candidateCount: eligible.length,
    scored: scored
      .sort((a, b) => b.score - a.score || a.m.itemId.localeCompare(b.m.itemId))
      .slice(0, 20)
      .map((s) => ({ itemId: s.m.itemId, score: s.score })),
  };
}

function scoreMaterial(m: Material, nowMs: number, maxAgeMs: number, config: PatrolActionConfig): number {
  const age = Math.max(0, nowMs - Date.parse(m.occurredAt));
  const freshness = 3 - Math.min(3, Math.floor((age / Math.max(1, maxAgeMs)) * 3));
  const f = config.filters;
  const serviceMatch =
    (f.service_codes?.includes(m.serviceCode) ? 1 : 0) +
    (m.featureKey && f.feature_keys?.includes(m.featureKey) ? 1 : 0);
  return freshness + serviceMatch;
}

// ─── 返信・追投稿 ────────────────────────────────────────

export interface ConversationState {
  status: "open" | "closed";
  expiresAt: number;
  lastBotAt: number;
  replyCount: number;
  unpromptedCount: number;
}

export interface ReplyEligibility {
  ok: boolean;
  reason: string;
}

/** 直接返信へ応答してよいか (CC-PATROL-07)。 */
export function canReply(conv: ConversationState, cfg: FollowupConfig, nowSec: number): ReplyEligibility {
  if (!cfg.reply_enabled) return { ok: false, reason: "reply disabled" };
  if (conv.status !== "open" || nowSec >= conv.expiresAt) return { ok: false, reason: "conversation closed" };
  const cap = Math.min(cfg.max_replies, PATROL_HARD_CAPS.maxReplies);
  if (conv.replyCount >= cap) return { ok: false, reason: `reply cap reached (${conv.replyCount}/${cap})` };
  return { ok: true, reason: "direct reply" };
}

export interface FollowupObservation {
  /** 最後の bot 発言以降の直接返信 (未処理含む)。 */
  directRepliesSinceLastBot: number;
  distinctReactors: number;
  fineReactors: number;
  badReactors: number;
  /** 同じ宛先で最後の bot 発言以降に来た人間の発言数 (bot / system / 別会話の自動発言を除く)。 */
  laterHumanMessages: number;
}

/** 無返信追投稿の可否。 閾値・経過・上限・反応の向きを満たす時だけ (CC-PATROL-07)。 */
export function evaluateFollowup(
  conv: ConversationState,
  obs: FollowupObservation,
  cfg: FollowupConfig,
  nowSec: number,
): ReplyEligibility {
  if (conv.status !== "open" || nowSec >= conv.expiresAt) return { ok: false, reason: "conversation closed" };
  if (obs.directRepliesSinceLastBot > 0) return { ok: false, reason: "has direct reply (reply path owns it)" };
  const cap = Math.min(cfg.max_unprompted, PATROL_HARD_CAPS.maxUnprompted);
  if (conv.unpromptedCount >= cap) return { ok: false, reason: `followup cap reached (${conv.unpromptedCount}/${cap})` };
  if (nowSec - conv.lastBotAt < cfg.min_wait_sec) return { ok: false, reason: "min wait not elapsed" };
  if (obs.badReactors > obs.fineReactors) return { ok: false, reason: "bad reactions dominant" };
  if (obs.distinctReactors >= cfg.reaction_threshold) {
    return { ok: true, reason: `reactions ${obs.distinctReactors} >= ${cfg.reaction_threshold}` };
  }
  if (obs.laterHumanMessages >= cfg.later_message_threshold) {
    return { ok: true, reason: `later messages ${obs.laterHumanMessages} >= ${cfg.later_message_threshold}` };
  }
  return { ok: false, reason: "thresholds not met" };
}

// ─── 優先順位 ────────────────────────────────────────────

export type PatrolAction =
  | { kind: "stop"; reason: string }
  | { kind: "reply"; conversationId: string; inboundIds: number[] }
  | { kind: "event"; eventId: number }
  | { kind: "followup"; conversationId: string; reason: string }
  | { kind: "pick" }
  | { kind: "skip"; reason: string };

export interface PendingReply {
  conversationId: string;
  inboundId: number;
}

export interface ChooseInput {
  stop: StopInput;
  /** 受信順。 */
  pendingReplies: readonly PendingReply[];
  /** 受信順。 */
  pendingEventIds: readonly number[];
  followups: ReadonlyArray<{ conversationId: string; eligibility: ReplyEligibility }>;
  tickDue: boolean;
  /** 新規投稿しない時間帯の中か。 返信だけを行い、 event / 追投稿 / 定期 pick は時間帯明けまで待たせる。 */
  quiet?: boolean;
}

/** "HH:MM" を 0 時からの分に。 */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * 新規投稿しない時間帯 (ローカル時刻) に now が入るか。 start > end は日付をまたぐ (例 22:00〜09:30)。
 * start == end は時間帯なし。
 */
export function inQuietHours(nowSec: number, quiet: { start: string; end: string } | null): boolean {
  if (!quiet) return false;
  const d = new Date(nowSec * 1000);
  const minute = d.getHours() * 60 + d.getMinutes();
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** 固定優先順位で次の行動を決める。 */
export function choosePatrolAction(input: ChooseInput): PatrolAction {
  const hasWork = input.pendingReplies.length > 0 || input.pendingEventIds.length > 0
    || input.followups.some((f) => f.eligibility.ok) || input.tickDue;
  if (!hasWork) return { kind: "skip", reason: "no candidate" };
  // 停止判定は描画が要る前提で見る (全行動が短文生成を伴うため)。
  const stop = stopReason(input.stop, true);
  if (stop) return { kind: "stop", reason: stop };

  if (input.pendingReplies.length > 0) {
    const head = input.pendingReplies[0];
    const batch = input.pendingReplies
      .filter((r) => r.conversationId === head.conversationId)
      .slice(0, PATROL_HARD_CAPS.replyBatch)
      .map((r) => r.inboundId);
    return { kind: "reply", conversationId: head.conversationId, inboundIds: batch };
  }
  // 返信以外は新規投稿。 時間帯の中は出さない (event は受信箱に残り、 時間帯明けに出る)。
  if (input.quiet) return { kind: "skip", reason: "quiet hours (新規投稿しない時間帯)" };
  if (input.pendingEventIds.length > 0) return { kind: "event", eventId: input.pendingEventIds[0] };
  const follow = input.followups.find((f) => f.eligibility.ok);
  if (follow) return { kind: "followup", conversationId: follow.conversationId, reason: follow.eligibility.reason };
  if (input.tickDue) {
    if (input.stop.rootsToday >= input.stop.config.root_limit_per_day) {
      return { kind: "skip", reason: `root limit reached (${input.stop.rootsToday}/${input.stop.config.root_limit_per_day} today)` };
    }
    return { kind: "pick" };
  }
  return { kind: "skip", reason: "no eligible candidate" };
}
