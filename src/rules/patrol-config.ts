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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * 子会社に勧める新規投稿しない時間帯 (neco 2026-10-15: 深夜帯〜始業は新規投稿しない、 返信はする)。
 * 全体の既定は「時間帯なし」(本社は時間帯なし、 同日 neco)。 子会社は既定値でこれを持つ。
 */
export const DEFAULT_QUIET_HOURS = { start: "22:00", end: "09:30" } as const;

const QuietHours = z.object({
  start: z.string().regex(HHMM, "HH:MM"),
  end: z.string().regex(HHMM, "HH:MM"),
}).strict();
const DiscordChannelId = z.string().regex(/^\d{17,20}$/, "Discord の channel ID (数字 17〜20 桁)");
const PersonaHint = z.string().trim().min(1).max(80);

/**
 * rule の持ち主 (子会社) から引き継ぐ項目の全体の既定値。 rule にも子会社の既定値にも無ければこれ。
 * spec/plan/2026-10-15-patrol-subsidiary-rules-design.md §2。
 */
export const GLOBAL_PATROL_DEFAULTS = {
  quiet_hours: null as { start: string; end: string } | null,
  root_limit_per_day: 8,
  discord_channel_id: null as string | null,
  persona_hint: null as string | null,
};

/** 子会社ごとの既定値 (すべて任意。 書かれていない項目は全体の既定値)。 */
export const SubsidiaryPatrolDefaults = z.object({
  quiet_hours: QuietHours.nullable().optional(),
  root_limit_per_day: z.number().int().min(1).max(48).optional(),
  discord_channel_id: DiscordChannelId.nullable().optional(),
  persona_hint: PersonaHint.nullable().optional(),
  /** 子会社まるごとの停止。 true の間は返信も含め新規の行動をしない。 */
  paused: z.boolean().optional(),
}).strict();
export type SubsidiaryPatrolDefaults = z.infer<typeof SubsidiaryPatrolDefaults>;

export function parseSubsidiaryDefaults(raw: unknown): { ok: true; defaults: SubsidiaryPatrolDefaults } | { ok: false; reason: string } {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ok: false, reason: "defaults is not valid JSON" }; }
  }
  const parsed = SubsidiaryPatrolDefaults.safeParse(value ?? {});
  if (!parsed.success) {
    return { ok: false, reason: `defaults: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  return { ok: true, defaults: parsed.data };
}

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
  /** 寄せたいジャンル (絞り込みではない)。 prefer_ratio の確率でこのジャンルの候補から選ぶ。 */
  prefer_genres: z.array(z.string().min(1).max(40)).max(30).optional(),
  prefer_ratio: z.number().min(0).max(1).optional(),
  service_codes: z.array(z.string().min(1).max(20)).max(30).optional(),
  feature_keys: z.array(z.string().min(1).max(60)).max(30).optional(),
  event_kinds: z.array(z.string().min(1).max(60)).max(30).optional(),
  max_age_sec: z.number().int().min(60).max(7 * 86400).default(86400),
});
export type PatrolFilters = z.infer<typeof PatrolFilters>;

/**
 * 保存される rule の action_config。 引き継ぐ項目 (quiet_hours / root_limit_per_day / discord_channel_id /
 * persona_hint) は「書かれていない (undefined) = 持ち主の子会社 → 全体の既定値を引き継ぐ」と
 * 「明示の null = 無し」を区別するため default を付けない。
 */
export const PatrolActionConfigInput = z.object({
  kind: z.literal("material-chat"),
  source_ids: z.array(z.string().min(1).max(64)).max(5).default([]),
  scope_key: z.string().min(1).max(40),
  filters: PatrolFilters.default({}),
  renderer: z.enum(["oneshot", "template"]).default("oneshot"),
  max_chars: z.number().int().min(40).max(PATROL_HARD_CAPS.maxChars).default(240),
  root_limit_per_day: z.number().int().min(1).max(PATROL_HARD_CAPS.rootLimitPerDay).optional(),
  llm_limit_per_day: z.number().int().min(0).max(PATROL_HARD_CAPS.llmLimitPerDay).default(16),
  followup: FollowupConfig.default({}),
  /** 新規投稿しない時間帯 (サーバのローカル時刻、 日付またぎ可)。 この間は返信だけを行う。 null で時間帯なし。 */
  quiet_hours: QuietHours.nullable().optional(),
  /**
   * 投稿先の Discord channel を個別に指定する (本社・子会社 guild のチャンネル)。 null なら rule.target の meta channel。
   * 指定した投稿は本社の chat 配信 (Discord meta / Slack) に流さず、 このチャンネルへ直接送る。
   */
  discord_channel_id: DiscordChannelId.nullable().optional(),
  /** 名乗りの雰囲気 (生成への指示。 判定には使わない)。 */
  persona_hint: PersonaHint.nullable().optional(),
}).strict();
export type PatrolActionConfigInput = z.infer<typeof PatrolActionConfigInput>;

/** 実行に使う実効設定。 引き継ぐ項目は rule → 持ち主の子会社の既定値 → 全体の既定値で埋まっている。 */
export type PatrolActionConfig = Omit<PatrolActionConfigInput, "root_limit_per_day" | "quiet_hours" | "discord_channel_id" | "persona_hint"> & {
  root_limit_per_day: number;
  quiet_hours: { start: string; end: string } | null;
  discord_channel_id: string | null;
  persona_hint: string | null;
};

export type ParsedConfig =
  | { ok: true; config: PatrolActionConfig; input: PatrolActionConfigInput }
  | { ok: false; reason: string };

/** rule の値 → 子会社の既定値 → 全体の既定値。 undefined だけを「書かれていない」とみなす (null は明示の無し)。 */
export function resolveEffectivePatrolConfig(
  input: PatrolActionConfigInput,
  inherit: SubsidiaryPatrolDefaults | null | undefined,
): PatrolActionConfig {
  const pick = <K extends keyof typeof GLOBAL_PATROL_DEFAULTS>(key: K): (typeof GLOBAL_PATROL_DEFAULTS)[K] => {
    const own = input[key];
    if (own !== undefined) return own as (typeof GLOBAL_PATROL_DEFAULTS)[K];
    const inherited = inherit?.[key];
    if (inherited !== undefined) return inherited as (typeof GLOBAL_PATROL_DEFAULTS)[K];
    return GLOBAL_PATROL_DEFAULTS[key];
  };
  return {
    ...input,
    root_limit_per_day: pick("root_limit_per_day"),
    quiet_hours: pick("quiet_hours"),
    discord_channel_id: pick("discord_channel_id"),
    persona_hint: pick("persona_hint"),
  };
}

export function parseActionConfig(raw: unknown, inherit?: SubsidiaryPatrolDefaults | null): ParsedConfig {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return { ok: false, reason: "action_config is not valid JSON" }; }
  }
  const parsed = PatrolActionConfigInput.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `action_config: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  }
  return { ok: true, config: resolveEffectivePatrolConfig(parsed.data, inherit), input: parsed.data };
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
  input: { trigger_type: "tick" | "event"; event_kind: string | null; config: PatrolActionConfig; subsidiaryId?: string | null },
  sources: SourceLookup,
): ReviewResult {
  const { config } = input;
  // 子会社の rule は公開素材だけ (本社限定の素材・出来事を子会社へ出さない、 CC-PATROL-05)。
  if (input.subsidiaryId && config.scope_key !== "public") {
    return { ok: false, reason: "子会社の巡回 rule は scope_key=public にする" };
  }
  if (!(KNOWN_PATROL_SCOPES as readonly string[]).includes(config.scope_key)) {
    return { ok: false, reason: `scope_key は ${KNOWN_PATROL_SCOPES.join("/")} のいずれか (got ${config.scope_key})` };
  }
  // 個別チャンネルは本社外 (子会社 guild) にもなりうるので、 公開素材だけを出す (CC-PATROL-05)。
  if (config.discord_channel_id && config.scope_key !== "public") {
    return { ok: false, reason: "discord_channel_id を指定した巡回 rule は scope_key=public にする (本社外へ本社限定の素材を出さない)" };
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
