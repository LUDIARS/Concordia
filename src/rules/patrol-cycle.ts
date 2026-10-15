/**
 * 巡回 rule 1 件の 1 周期 (spec/feature/patrol-chat.md §6)。
 *
 * 観測 (未処理返信・service event・会話の反応・定期の期日) を集め、 patrol-policy の固定優先順位で
 * 行動を 1 つ選んで実行する。 engine の mutex の中で呼ばれ、 並列生成を増やさない。
 */

import type { RuleConversationRow } from "../db/rule-conversations-repo.js";
import type { ServiceEventRow } from "../db/rule-service-events-repo.js";
import type { RuleRow } from "../db/rules-repo.js";
import {
  executeEvent,
  executeFollowup,
  executePick,
  executeReply,
  observeFollowup,
  type ExecuteOutcome,
  type RunContext,
} from "./execute-patrol.js";
import { parseActionConfig, type PatrolActionConfig } from "./patrol-config.js";
import { choosePatrolAction, computeNextDueAt } from "./patrol-policy.js";
import { dayStartSec, nowSecOf, type PatrolPorts } from "./patrol-ports.js";
import { resolveChannelFor } from "./patrol-channel.js";

export type CycleOutcome =
  | { kind: "idle"; reason: string }
  | { kind: "stopped"; reason: string }
  | { kind: "acted"; action: string; outcome: ExecuteOutcome };

export interface CycleOptions {
  /** 深夜帯の行動頻度 (1 = 通常、 0.1 = 1/10)。 定期 tick の間隔だけに効き、 返信は待たせない。 */
  frequency: number;
}

/** service event が rule の型付き filter と宛先 scope に合うか。 */
export function eventMatches(ev: ServiceEventRow, config: PatrolActionConfig): boolean {
  const f = config.filters;
  if (f.service_codes?.length && !f.service_codes.includes(ev.service_code)) return false;
  if (f.feature_keys?.length && (!ev.feature_key || !f.feature_keys.includes(ev.feature_key))) return false;
  if (f.event_kinds?.length && !f.event_kinds.includes(ev.event_kind)) return false;
  return ev.scope_key === "public" || ev.scope_key === config.scope_key;
}

export async function runPatrolCycle(
  ports: PatrolPorts,
  rule: RuleRow,
  options: CycleOptions,
): Promise<CycleOutcome> {
  const parsed = parseActionConfig(rule.action_config);
  if (!parsed.ok) return { kind: "idle", reason: `invalid action_config: ${parsed.reason}` };
  const config = parsed.config;
  const now = nowSecOf(ports);
  const ctx: RunContext = { ports, rule, config, channel: resolveChannelFor(rule) };

  // 定期: 初回は即発火させず、 rule ID 由来の jitter 付きで次回を決める (再起動の一斉発火を防ぐ)。
  let tickDue = false;
  if (rule.trigger_type === "tick" && rule.tick_sec) {
    const effectiveTick = Math.round(rule.tick_sec / Math.max(0.01, Math.min(1, options.frequency)));
    if (rule.next_due_at === null) {
      ports.rules.setNextDue(rule.id, computeNextDueAt(rule.id, effectiveTick, now));
    } else if (now >= rule.next_due_at) {
      tickDue = true;
    }
  }

  const pendingEvents = rule.trigger_type === "event"
    ? ports.events.pending().filter((ev) => eventMatches(ev, config))
    : [];
  const pendingInbound = ports.conversations.pendingInbound(rule.id);
  const openConversations = ports.conversations.listOpen(rule.id, now);
  const followups = openConversations.map((conv) => ({
    conversationId: conv.conversation_id,
    eligibility: observeFollowup(ctx, conv),
  }));
  const usage = ports.runs.usageSince(rule.id, dayStartSec(now));

  const action = choosePatrolAction({
    stop: {
      runtimeDisabled: ports.runtimeDisabled(),
      ruleEnabled: !!rule.enabled && !rule.removed_at,
      config,
      rootsToday: usage.roots,
      llmCallsToday: usage.llmCalls,
    },
    pendingReplies: pendingInbound.map((i) => ({ conversationId: i.conversation_id, inboundId: i.inbound_chat_id })),
    pendingEventIds: pendingEvents.map((ev) => ev.id),
    followups,
    tickDue,
  });

  const advanceTick = () => {
    if (!tickDue || !rule.tick_sec) return;
    const effectiveTick = Math.round(rule.tick_sec / Math.max(0.01, Math.min(1, options.frequency)));
    ports.rules.setNextDue(rule.id, computeNextDueAt(rule.id, effectiveTick, now));
  };

  switch (action.kind) {
    case "skip":
      if (tickDue) {
        ports.rules.log({ rule_id: rule.id, action: "skip", actor: "engine", detail: action.reason });
        ports.rules.markAttempt(rule.id, now, false);
        advanceTick();
      }
      return { kind: "idle", reason: action.reason };
    case "stop":
      // 停止中も定期の期日は進める (停止解除時に溜まった分を一斉に出さない)。
      advanceTick();
      return { kind: "stopped", reason: action.reason };
    case "reply": {
      const conv = ports.conversations.find(action.conversationId);
      if (!conv) {
        ports.conversations.settleInbound(action.inboundIds, "dropped", null, "conversation missing");
        return { kind: "idle", reason: "conversation missing" };
      }
      return { kind: "acted", action: "reply", outcome: await executeReply(ctx, conv, action.inboundIds) };
    }
    case "event": {
      const ev = pendingEvents.find((e) => e.id === action.eventId)!;
      return { kind: "acted", action: "event", outcome: await executeEvent(ctx, ev) };
    }
    case "followup": {
      const conv = openConversations.find((c) => c.conversation_id === action.conversationId) as RuleConversationRow;
      return { kind: "acted", action: "followup", outcome: await executeFollowup(ctx, conv) };
    }
    case "pick": {
      advanceTick();
      // trigger_key は期日で一意。 同じ期日の再実行 (再起動直後など) は duplicate になる。
      return { kind: "acted", action: "pick", outcome: await executePick(ctx, `tick:${rule.id}:${rule.next_due_at}`) };
    }
  }
}
