/**
 * ルールの決定的レビュー (発火前チェック).
 *
 * 外部から注入されたルールデータを **LLM を一切使わず** 機械的に検証する.
 * 通れば即時 enabled、 落ちれば reason 付きで弾く (人間承認は挟まない方針).
 *
 * チェック項目:
 *  - 禁則パターン (無音 / 進捗確認 / 汎用雑談 系は noise なので拒否)
 *  - trigger 整合 (tick は tick_sec 必須・範囲、 event は event_kind 必須・既知)
 *  - channel / cooldown の範囲
 *
 * id 衝突や zod スキーマ検証は呼び出し側 (api/rules.ts) が担う (SRP).
 */

import type { TriggerType } from "../db/rules-repo.js";

/** rule engine が認識する channel (= chat-repo.ChatChannel と一致させる). */
export const KNOWN_CHANNELS = ["chitchat", "consultation", "報告", "ぼやき", "system"] as const;

/** rule engine が認識する event_kind 一覧 (`*` で全 event). */
export const KNOWN_EVENT_KINDS = [
  "*",
  "session.started",
  "session.ended",
  "session.lost",
  "session.event",
  "chat.posted",
  "task.enqueued",
  "skill.snapshot",
  "report.generated",
  "rule.changed",
] as const;

/**
 * id / description / instructions にこれらが含まれるルールは拒否する.
 * memory feedback と同期 (no-silent-check / no-progress-check / chitchat-role-grounded).
 */
export const FORBIDDEN_RULE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /無音|沈黙|silence|quiet/i, reason: "無音 / 沈黙確認系 rule は禁止 (event log で見える、 冗長)" },
  {
    pattern: /進捗(どう|確認|聞|を聞|ping)|progress[-_ ]?(check|ping)/i,
    reason: "進捗確認系 rule は禁止 (/v1/stat poll で完結)",
  },
  {
    pattern: /汎用雑談|general[-_ ]?chitchat|small[-_ ]?talk[-_ ]?random/i,
    reason: "ロール無関係な汎用雑談 rule は禁止 (persona の役割に紐づけること)",
  },
];

export interface ReviewableRule {
  id: string;
  description?: string | null;
  trigger_type: TriggerType;
  tick_sec?: number | null;
  event_kind?: string | null;
  target?: string | null;
  cooldown_sec?: number | null;
  instructions: string;
}

export type ReviewResult = { ok: true } | { ok: false; reason: string };

/** 禁則パターンチェックのみ (単体テスト / 他経路からの再利用用). */
export function checkForbiddenRule(rule: { id: string; description?: string | null; instructions: string }): ReviewResult {
  const blob = `${rule.id}\n${rule.description ?? ""}\n${rule.instructions}`;
  for (const { pattern, reason } of FORBIDDEN_RULE_PATTERNS) {
    if (pattern.test(blob)) return { ok: false, reason };
  }
  return { ok: true };
}

/**
 * 注入ルールの総合決定的レビュー. 通れば { ok:true }、 落ちれば reason 付き.
 */
export function reviewRule(rule: ReviewableRule): ReviewResult {
  const forbidden = checkForbiddenRule(rule);
  if (!forbidden.ok) return forbidden;

  if (rule.trigger_type === "tick") {
    const sec = rule.tick_sec ?? null;
    if (sec === null) return { ok: false, reason: "trigger_type=tick には tick_sec が必須" };
    if (sec < 5 || sec > 86400) return { ok: false, reason: `tick_sec は 5〜86400 の範囲 (got ${sec})` };
  } else if (rule.trigger_type === "event") {
    const kind = rule.event_kind ?? null;
    if (!kind) return { ok: false, reason: "trigger_type=event には event_kind が必須" };
    if (!(KNOWN_EVENT_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, reason: `未知の event_kind: ${kind}` };
    }
  } else {
    return { ok: false, reason: `未知の trigger_type: ${String(rule.trigger_type)}` };
  }

  if (rule.target && !(KNOWN_CHANNELS as readonly string[]).includes(rule.target)) {
    return { ok: false, reason: `target は channel 名であること (${KNOWN_CHANNELS.join("/")}); got ${rule.target}` };
  }

  const cd = rule.cooldown_sec ?? 0;
  if (cd < 0 || cd > 86400) return { ok: false, reason: `cooldown_sec は 0〜86400 の範囲 (got ${cd})` };

  return { ok: true };
}
