/**
 * 巡回チャット rule (config_version=2) の設定スキーマと実効検証 (spec/feature/patrol-chat.md §5).
 *
 * PUT / PATCH / toggle-enable / rollback は更新後の全体をここで検証する (CC-PATROL-08)。
 * LLM は判定に関わらない。 scope / 宛先 / 上限は既知の値と hard cap で縛る。
 */

import { z } from "zod";
import type { ReviewResult } from "./review.js";

/** hard cap: rule の設定でもこれ以上には上げられない (CC-PATROL-07)。 */
export const PATROL_HARD_CAPS = {
  rootLimitPerDay: 48,
  llmLimitPerDay: 96,
  maxReplies: 8,
  maxUnprompted: 2,
  maxChars: 400,
  windowSec: 86400,
  replyBatch: 3,
} as const;

/** 巡回の投稿先として許す scope。 共通 chat は公開素材だけを受ける。 */
export const KNOWN_PATROL_SCOPES = ["hq", "public"] as const;

export const FollowupConfig = z.object({
  reply_enabled: z.boolean().default(true),
  reaction_threshold: z.number().int().min(1).max(100).default(3),
  later_message_threshold: z.number().int().min(1).max(100).default(4),
  min_wait_sec: z.number().int().min(60).max(86400).default(600),
  window_sec: z.number().int().min(600).max(PATROL_HARD_CAPS.windowSec).default(21600),
  max_unprompted: z.number().int().min(0).max(PATROL_HARD_CAPS.maxUnprompted).default(1),
  max_replies: z.number().int().min(0).max(PATROL_HARD_CAPS.maxReplies).default(4),
});
export type FollowupConfig = z.infer<typeof FollowupConfig>;

export const PatrolFilters = z.object({
  genres: z.array(z.string().min(1).max(40)).max(30).optional(),
  service_codes: z.array(z.string().min(1).max(20)).max(30).optional(),
  feature_keys: z.array(z.string().min(1).max(60)).max(30).optional(),
  event_kinds: z.array(z.string().min(1).max(60)).max(30).optional(),
  max_age_sec: z.number().int().min(60).max(7 * 86400).default(86400),
});
export type PatrolFilters = z.infer<typeof PatrolFilters>;

export const PatrolActionConfig = z.object({
  kind: z.literal("material-chat"),
  source_ids: z.array(z.string().min(1).max(64)).max(5).default([]),
  scope_key: z.string().min(1).max(40),
  filters: PatrolFilters.default({}),
  renderer: z.enum(["oneshot", "template"]).default("oneshot"),
  max_chars: z.number().int().min(40).max(PATROL_HARD_CAPS.maxChars).default(240),
  root_limit_per_day: z.number().int().min(1).max(PATROL_HARD_CAPS.rootLimitPerDay).default(8),
  llm_limit_per_day: z.number().int().min(0).max(PATROL_HARD_CAPS.llmLimitPerDay).default(16),
  followup: FollowupConfig.default({}),
}).strict();
export type PatrolActionConfig = z.infer<typeof PatrolActionConfig>;

export type ParsedConfig = { ok: true; config: PatrolActionConfig } | { ok: false; reason: string };

export function parseActionConfig(raw: unknown): ParsedConfig {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ok: false, reason: "action_config is not valid JSON" }; }
  }
  const parsed = PatrolActionConfig.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `action_config: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  return { ok: true, config: parsed.data };
}

export interface SourceLookup {
  has(sourceId: string): boolean;
  describe(sourceId: string): { scopes: string[]; kind: "trend" | "activity"; unavailable: string | null } | null;
}

/**
 * v2 rule の実効検証。 trigger の検証は既存 reviewRule が持つので、 ここは巡回固有の整合だけを見る。
 * - tick は素材元が 1 つ以上要る (素材なしで定期投稿させない)
 * - 素材元は allowlist 登録済みで、 宛先 scope に出せる範囲であること (CC-PATROL-05)
 * - event は service/feature/event_kind の型付き filter のどれかを要求する (wildcard を本文へ流さない)
 */
export function reviewPatrolConfig(
  input: { trigger_type: "tick" | "event"; event_kind: string | null; config: PatrolActionConfig },
  sources: SourceLookup,
): ReviewResult {
  const { config } = input;
  if (!(KNOWN_PATROL_SCOPES as readonly string[]).includes(config.scope_key)) {
    return { ok: false, reason: `scope_key は ${KNOWN_PATROL_SCOPES.join("/")} のいずれか (got ${config.scope_key})` };
  }
  if (input.trigger_type === "tick" && config.source_ids.length === 0) {
    return { ok: false, reason: "tick の巡回 rule には source_ids が 1 つ以上必要" };
  }
  for (const id of config.source_ids) {
    if (!sources.has(id)) return { ok: false, reason: `未登録の素材元: ${id}` };
    const d = sources.describe(id)!;
    if (d.unavailable === "contract-unverified") {
      return { ok: false, reason: `素材元 ${id} は契約未確認のため選択できない (contract-unverified)` };
    }
    if (!d.scopes.includes("*") && !d.scopes.includes(config.scope_key)) {
      return { ok: false, reason: `素材元 ${id} は scope ${config.scope_key} へ出せない` };
    }
  }
  if (input.trigger_type === "event") {
    if (input.event_kind !== "service.event") {
      return { ok: false, reason: "巡回の event rule は event_kind=service.event だけを受ける" };
    }
    const f = config.filters;
    if (!f.service_codes?.length && !f.feature_keys?.length && !f.event_kinds?.length) {
      return { ok: false, reason: "service.event rule には service_codes / feature_keys / event_kinds のいずれかの filter が必要" };
    }
  }
  if (config.renderer === "oneshot" && config.llm_limit_per_day === 0) {
    return { ok: false, reason: "renderer=oneshot なら llm_limit_per_day は 1 以上" };
  }
  return { ok: true };
}
