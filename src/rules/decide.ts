/**
 * ブラックボックス発火判定 (決定的・LLM 不使用).
 *
 * ルールが「今・どの channel に・どんな意図で」 発話すべきかを、 世界状態
 * (active session 数など) と rule の conditions から **機械的に** 決める.
 * 実際の発話文は描画しない (それは chat/render.ts の Haiku 担当).
 *
 * timing (tick 間隔 / event / cooldown) は engine.ts が握り、 ここは
 * 「発火可否 + 宛先解決」 のみ (SRP).
 */

import type { RuleRow } from "../db/rules-repo.js";
import type { ChatChannel } from "../db/chat-repo.js";
import type { ChatIntent } from "../chat/render.js";

export interface DecideCtx {
  nowSec: number;
  activeSessionCount: number;
}

export interface FireDecision {
  fire: boolean;
  reason: string;
  channel: ChatChannel;
  intent: ChatIntent;
}

const DEFAULT_CHANNEL: ChatChannel = "chitchat";

const VALID_CHANNELS: ChatChannel[] = ["chitchat", "consultation", "報告", "ぼやき", "system"];
const VALID_INTENTS: ChatIntent[] = ["chitchat", "review", "reply", "react", "notice", "consult"];

interface Condition {
  type: string;
  value?: unknown;
}

function parseConditions(raw: string): Condition[] {
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((c): c is Condition => !!c && typeof c === "object" && typeof (c as any).type === "string") : [];
  } catch {
    return [];
  }
}

function resolveChannel(rule: RuleRow, conds: Condition[]): ChatChannel {
  const fromCond = conds.find((c) => c.type === "channel")?.value;
  if (typeof fromCond === "string" && (VALID_CHANNELS as string[]).includes(fromCond)) {
    return fromCond as ChatChannel;
  }
  if (rule.target && (VALID_CHANNELS as string[]).includes(rule.target)) {
    return rule.target as ChatChannel;
  }
  return DEFAULT_CHANNEL;
}

function resolveIntent(channel: ChatChannel, conds: Condition[]): ChatIntent {
  const fromCond = conds.find((c) => c.type === "intent")?.value;
  if (typeof fromCond === "string" && (VALID_INTENTS as string[]).includes(fromCond)) {
    return fromCond as ChatIntent;
  }
  // channel から既定 intent を導出
  if (channel === "consultation") return "consult";
  if (channel === "報告") return "notice";
  return "chitchat";
}

/**
 * 発火可否を決定的に判定する. timing (cooldown 等) は呼び出し側で済んでいる前提.
 */
export function decideRuleFire(rule: RuleRow, ctx: DecideCtx): FireDecision {
  const conds = parseConditions(rule.conditions);
  const channel = resolveChannel(rule, conds);
  const intent = resolveIntent(channel, conds);

  for (const c of conds) {
    if (c.type === "any_active_session") {
      if (ctx.activeSessionCount === 0) {
        return { fire: false, reason: "no active session", channel, intent };
      }
    }
    if (c.type === "min_active_sessions") {
      const n = typeof c.value === "number" ? c.value : 1;
      if (ctx.activeSessionCount < n) {
        return { fire: false, reason: `active sessions < ${n}`, channel, intent };
      }
    }
  }

  return { fire: true, reason: "conditions met", channel, intent };
}
