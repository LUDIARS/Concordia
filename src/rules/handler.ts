/**
 * AI 応答の action を解釈して副作用 (chat post / rule add / rule remove) を実行する.
 *
 * 全て log に残す.
 */

import { z } from "zod";
import type { ChatRepo, ChatChannel } from "../db/chat-repo.js";
import type { RulesRepo, TriggerType } from "../db/rules-repo.js";
import { isActionableSuggestion } from "../chat-actionable.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("rule-handler");

const PostSchema = z.object({
  action: z.literal("post"),
  channel: z.string().min(1).max(32),
  text: z.string().min(1).max(2000),
  reasoning: z.string().optional(),
});

const SkipSchema = z.object({
  action: z.literal("skip"),
  reasoning: z.string().optional(),
});

const AddRuleSchema = z.object({
  action: z.literal("add_rule"),
  rule: z.object({
    id: z.string().min(1).max(64),
    description: z.string().optional(),
    trigger_type: z.enum(["tick", "event"]),
    tick_sec: z.number().int().min(5).max(3600).nullable().optional(),
    event_kind: z.string().nullable().optional(),
    conditions: z.array(z.unknown()).optional(),
    instructions: z.string().min(1).max(2000),
    target: z.string().nullable().optional(),
    cooldown_sec: z.number().int().min(0).max(86400).optional(),
  }),
  reasoning: z.string().optional(),
});

const RemoveRuleSchema = z.object({
  action: z.literal("remove_rule"),
  rule_id: z.string().min(1).max(64),
  reasoning: z.string().min(1).max(500),
});

const ActionSchema = z.union([PostSchema, SkipSchema, AddRuleSchema, RemoveRuleSchema]);

export interface HandlerDeps {
  chat: ChatRepo;
  rules: RulesRepo;
}

export type Action = z.infer<typeof ActionSchema>;

export function handleAction(deps: HandlerDeps, ruleId: string, raw: unknown): { applied: boolean; action_type?: string; detail?: string } {
  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) {
    deps.rules.log({ rule_id: ruleId, action: "error", actor: "engine", detail: `bad shape: ${parsed.error.message.slice(0, 200)}` });
    return { applied: false, detail: "schema invalid" };
  }
  const a = parsed.data;

  if (a.action === "skip") {
    deps.rules.log({ rule_id: ruleId, action: "skip", actor: "ai", detail: a.reasoning });
    return { applied: true, action_type: "skip" };
  }

  if (a.action === "post") {
    const actionable = isActionableSuggestion(a.text);
    const msg = deps.chat.insert({
      channel: a.channel as ChatChannel,
      session_id: null,
      author_label: "concordia",
      text: a.text,
      in_reply_to: null,
      is_actionable: actionable,
      metadata: a.reasoning ? JSON.stringify({ via_rule: ruleId, reasoning: a.reasoning }) : null,
    });
    eventBus.emit({
      type: "chat.posted",
      message_id: msg.id,
      channel: msg.channel,
      author_label: msg.author_label,
      ts: msg.ts,
      is_actionable: actionable,
    });
    deps.rules.log({
      rule_id: ruleId,
      action: "fire",
      actor: "ai",
      detail: `posted to ${a.channel}: ${a.text.slice(0, 80)}`,
    });
    return { applied: true, action_type: "post", detail: a.channel };
  }

  if (a.action === "add_rule") {
    const r = a.rule;
    const existing = deps.rules.find(r.id);
    if (existing) {
      deps.rules.log({ rule_id: ruleId, action: "error", actor: "ai", detail: `add_rule: id collision ${r.id}` });
      return { applied: false, detail: "id collision" };
    }
    deps.rules.insert({
      id: r.id,
      description: r.description ?? null,
      trigger_type: r.trigger_type as TriggerType,
      tick_sec: r.tick_sec ?? null,
      event_kind: r.event_kind ?? null,
      conditions: JSON.stringify(r.conditions ?? []),
      instructions: r.instructions,
      target: r.target ?? null,
      cooldown_sec: r.cooldown_sec ?? 60,
      added_by: "ai",
    });
    deps.rules.log({
      rule_id: r.id,
      action: "add",
      actor: "ai",
      detail: a.reasoning ?? "added by AI",
    });
    eventBus.emit({ type: "rule.changed", rule_id: r.id, action: "add", ts: Math.floor(Date.now() / 1000) });
    log.info({ rule_id: r.id }, "rule added by AI");
    return { applied: true, action_type: "add_rule", detail: r.id };
  }

  if (a.action === "remove_rule") {
    const existing = deps.rules.find(a.rule_id);
    if (!existing) {
      deps.rules.log({ rule_id: ruleId, action: "error", actor: "ai", detail: `remove_rule: not found ${a.rule_id}` });
      return { applied: false, detail: "not found" };
    }
    if (existing.removed_at) {
      return { applied: false, detail: "already removed" };
    }
    deps.rules.remove(a.rule_id, "ai", a.reasoning);
    deps.rules.log({
      rule_id: a.rule_id,
      action: "remove",
      actor: "ai",
      detail: a.reasoning,
    });
    eventBus.emit({ type: "rule.changed", rule_id: a.rule_id, action: "remove", ts: Math.floor(Date.now() / 1000) });
    log.info({ rule_id: a.rule_id, reason: a.reasoning }, "rule removed by AI");
    return { applied: true, action_type: "remove_rule", detail: a.rule_id };
  }

  return { applied: false, detail: "unknown action" };
}
