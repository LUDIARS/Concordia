/**
 * 巡回チャットの 1 行動を実行する use case (spec/feature/patrol-chat.md §6–§8)。
 *
 *   claim (trigger_key UNIQUE) → 素材選択 → 生成 (最大 1 回) → 本文保存 → 送信直前の停止再検査
 *   → chat 投稿と run の chat_message_id を同一 transaction で確定 → chat.posted で配達を起こす
 *
 * - 状態は各境界で DB に保存し、 生成済み本文は再生成しない (CC-PATROL-02)
 * - 無効化 / runtime OFF / lease 喪失後は送信しない (CC-PATROL-06)
 * - 失敗・skip・素材なしは理由付きで別状態に残す (CC-PATROL-09)
 */

import type { ChatMessageRow } from "../db/chat-repo.js";
import type { RuleConversationRow } from "../db/rule-conversations-repo.js";
import type { RunActionKind, RuleRunRow } from "../db/rule-runs-repo.js";
import type { ServiceEventRow } from "../db/rule-service-events-repo.js";
import type { RuleRow } from "../db/rules-repo.js";
import { MaterialSourceError, type Material } from "./material-types.js";
import type { PatrolActionConfig } from "./patrol-config.js";
import { canReply, evaluateFollowup, pickMaterial, seededRandom } from "./patrol-policy.js";
import {
  PATROL_LEASE_SEC,
  PATROL_MESSAGE_SOURCE,
  nowSecOf,
  type PatrolPorts,
} from "./patrol-ports.js";
import { personaOfChatMetadata, personaOfDecision, personaUsername, withPersonaDecision } from "./patrol-persona.js";
import { externalChannelOfMessage } from "./patrol-inbound.js";
import type { RenderKind, RenderMaterial } from "./render-patrol.js";

export type ExecuteOutcome =
  | { status: "posted"; runId: string; chatMessageId: number }
  | { status: "duplicate" }
  | { status: "skipped" | "failed"; runId: string | null; reason: string };

interface RunContext {
  ports: PatrolPorts;
  rule: RuleRow;
  config: PatrolActionConfig;
  channel: string;
}

function claimRun(ctx: RunContext, kind: RunActionKind, triggerKey: string, conversationId: string | null): RuleRunRow | null {
  const now = nowSecOf(ctx.ports);
  return ctx.ports.runs.claim({
    run_id: ctx.ports.newId(),
    rule_id: ctx.rule.id,
    rule_revision: ctx.rule.revision,
    trigger_key: triggerKey,
    action_kind: kind,
    conversation_id: conversationId,
    scope_key: ctx.config.scope_key,
    channel: ctx.channel,
    lease_owner: ctx.ports.leaseOwner,
    lease_until: now + PATROL_LEASE_SEC,
    now,
  });
}

function finish(ctx: RunContext, run: RuleRunRow, status: "skipped" | "failed", reason: string, errorCode: string | null): ExecuteOutcome {
  ctx.ports.runs.transition(
    run.run_id, ctx.ports.leaseOwner,
    ["claimed", "material_selected", "rendering", "rendered"], status,
    { reason, ...(errorCode ? { error_code: errorCode } : {}) },
    nowSecOf(ctx.ports),
  );
  ctx.ports.rules.log({ rule_id: ctx.rule.id, action: status === "failed" ? "error" : "skip", actor: "engine", detail: `${run.action_kind}: ${reason}` });
  return { status, runId: run.run_id, reason };
}

/** 送信直前の停止再検査。 rule の現在値を読み直す (無効化は固定版より優先、 CC-PATROL-08)。 */
function sendBlocker(ctx: RunContext): string | null {
  if (ctx.ports.runtimeDisabled()) return "rules disabled at runtime before send";
  const current = ctx.ports.rules.find(ctx.rule.id);
  if (!current || !current.enabled || current.removed_at) return "rule disabled before send";
  if (current.execution_mode !== "patrol") return "rule left patrol mode before send";
  return null;
}

/** 生成 → 保存 → 停止再検査 → chat 確定。 */
async function renderAndCommit(
  ctx: RunContext,
  run: RuleRunRow,
  render: { kind: RenderKind; material: RenderMaterial | null; replies: string[]; previousBotText: string | null; persona: string | null },
  post: { inReplyTo: number | null; conversationId: string | null },
): Promise<{ ok: true; chat: ChatMessageRow } | { ok: false; outcome: ExecuteOutcome }> {
  const { ports } = ctx;
  if (!ports.runs.transition(run.run_id, ports.leaseOwner, ["claimed", "material_selected"], "rendering", { render_attempts_inc: 1 }, nowSecOf(ports))) {
    return { ok: false, outcome: { status: "skipped", runId: run.run_id, reason: "lease lost before render" } };
  }
  const result = await ports.render({
    mode: ctx.config.renderer,
    kind: render.kind,
    instructions: ctx.rule.instructions,
    material: render.material,
    replies: render.replies,
    previousBotText: render.previousBotText,
    maxChars: ctx.config.max_chars,
    persona: render.persona,
  });
  if (!result.ok) {
    ports.runs.transition(run.run_id, ports.leaseOwner, ["rendering"], "failed",
      { reason: result.error, error_code: "render_failed", llm_calls_inc: result.llmCalls }, nowSecOf(ports));
    ports.rules.log({ rule_id: ctx.rule.id, action: "error", actor: "engine", detail: `${run.action_kind}: ${result.error}` });
    return { ok: false, outcome: { status: "failed", runId: run.run_id, reason: result.error } };
  }
  // 名乗りは本文と一緒に run へ保存し、 復旧で投稿を確定するときも同じ名前で出す
  const decision = withPersonaDecision(ports.runs.find(run.run_id)?.decision ?? null, result.persona);
  if (!ports.runs.transition(run.run_id, ports.leaseOwner, ["rendering"], "rendered",
    { rendered_text: result.text, decision, llm_calls_inc: result.llmCalls }, nowSecOf(ports))) {
    return { ok: false, outcome: { status: "skipped", runId: run.run_id, reason: "lease lost after render" } };
  }
  const blocker = sendBlocker(ctx);
  if (blocker) return { ok: false, outcome: finish(ctx, run, "skipped", blocker, null) };
  return commitRendered(ctx, run.run_id, post);
}

/** 保存済み本文を chat へ確定する (再起動後の復旧でも使う。 再生成しない)。 */
export function commitRendered(
  ctx: RunContext,
  runId: string,
  post: { inReplyTo: number | null; conversationId: string | null },
): { ok: true; chat: ChatMessageRow } | { ok: false; outcome: ExecuteOutcome } {
  const { ports } = ctx;
  const persona = personaOfDecision(ports.runs.find(runId)?.decision ?? null);
  let chat: ChatMessageRow | null = null;
  const chatId = ports.runs.commitChat(runId, ports.leaseOwner, nowSecOf(ports), (text) => {
    chat = ports.chat.insert({
      channel: ctx.channel,
      text,
      in_reply_to: post.inReplyTo,
      ...(persona ? { author_label: personaUsername(persona) } : {}),
      metadata: {
        source: PATROL_MESSAGE_SOURCE,
        rule_id: ctx.rule.id,
        run_id: runId,
        conversation_id: post.conversationId,
        scope: ctx.config.scope_key,
        ...(persona ? { patrol_persona: persona, webhook_username: personaUsername(persona) } : {}),
        ...(ctx.config.discord_channel_id ? { patrol_discord_channel_id: ctx.config.discord_channel_id } : {}),
      },
    });
    return chat.id;
  });
  if (chatId === null || !chat) {
    return { ok: false, outcome: { status: "skipped", runId, reason: "run not committable (lease lost or state changed)" } };
  }
  ports.rules.markAttempt(ctx.rule.id, nowSecOf(ports), true);
  ports.rules.log({ rule_id: ctx.rule.id, action: "fire", actor: "engine", detail: `posted chat #${chatId} (run ${runId})` });
  ports.emitChatPosted(chat);
  return { ok: true, chat };
}

function materialOf(m: Material): RenderMaterial {
  return { title: m.title, excerpt: m.excerpt, ...(m.url ? { url: m.url } : {}) };
}

/** 新しい会話を開いて run に結び付ける。 */
function openConversation(ctx: RunContext, run: RuleRunRow, chat: ChatMessageRow, sourceRef: string | null): void {
  const now = nowSecOf(ctx.ports);
  const conversationId = ctx.ports.newId();
  ctx.ports.conversations.open({
    conversation_id: conversationId,
    rule_id: ctx.rule.id,
    rule_revision: ctx.rule.revision,
    root_chat_id: chat.id,
    channel: ctx.channel,
    scope_key: ctx.config.scope_key,
    source_ref: sourceRef,
    expires_at: now + ctx.config.followup.window_sec,
    now,
  });
  ctx.ports.runs.markConversation(run.run_id, conversationId, now);
}

// ─── pick (定期素材) ─────────────────────────────────────

export async function executePick(ctx: RunContext, triggerKey: string): Promise<ExecuteOutcome> {
  const { ports, config } = ctx;
  const run = claimRun(ctx, "pick", triggerKey, null);
  if (!run) return { status: "duplicate" };
  const nowMs = ports.nowMs();
  const since = new Date(nowMs - config.filters.max_age_sec * 1000).toISOString();
  const items: Material[] = [];
  const errors: string[] = [];
  for (const sourceId of config.source_ids) {
    const at = new Date(nowMs).toISOString();
    try {
      const page = await ports.sources.resolve(sourceId).list({ since, limit: 100, scopeKey: config.scope_key });
      items.push(...page.items);
      ports.sources.observe(sourceId, at, null);
    } catch (err) {
      const code = err instanceof MaterialSourceError ? err.code : "unavailable";
      errors.push(`${sourceId}:${code}`);
      ports.sources.observe(sourceId, at, `${code}: ${(err as Error).message}`);
    }
  }
  if (items.length === 0 && errors.length > 0) {
    return finish(ctx, run, "failed", `source error (${errors.join(", ")})`, `source_error:${errors[0].split(":").pop()}`);
  }
  const seed = Math.floor(ports.random() * 0x1_0000_0000);
  const pick = pickMaterial(items, {
    nowMs,
    scopeKey: config.scope_key,
    config,
    usedItemIds: ports.runs.usedItemIds(ctx.rule.id, Math.floor(nowMs / 1000) - 30 * 86400),
    random: seededRandom(seed),
  });
  const decision = JSON.stringify({ candidateCount: pick.candidateCount, scored: pick.scored, sourceErrors: errors });
  if (!pick.picked) {
    ports.runs.transition(run.run_id, ports.leaseOwner, ["claimed"], "skipped",
      { reason: pick.reason, decision, seed }, nowSecOf(ports));
    ports.rules.markAttempt(ctx.rule.id, nowSecOf(ports), false);
    ports.rules.log({ rule_id: ctx.rule.id, action: "skip", actor: "engine", detail: `pick: ${pick.reason}` });
    return { status: "skipped", runId: run.run_id, reason: pick.reason };
  }
  if (!ports.runs.transition(run.run_id, ports.leaseOwner, ["claimed"], "material_selected", {
    source_ref: pick.picked.itemId,
    material_snapshot: JSON.stringify(pick.picked),
    seed,
    decision,
    reason: pick.reason,
  }, nowSecOf(ports))) {
    return { status: "skipped", runId: run.run_id, reason: "lease lost before material" };
  }
  const committed = await renderAndCommit(ctx, run,
    { kind: "pick", material: materialOf(pick.picked), replies: [], previousBotText: null, persona: null },
    { inReplyTo: null, conversationId: null });
  if (!committed.ok) return committed.outcome;
  openConversation(ctx, run, committed.chat, pick.picked.itemId);
  return { status: "posted", runId: run.run_id, chatMessageId: committed.chat.id };
}

// ─── service event (短い報告) ────────────────────────────

export function eventToMaterial(ev: ServiceEventRow, observedAt: string): Material {
  return {
    sourceId: "service-event",
    itemId: `event:${ev.source_event_id}`,
    version: ev.source_event_id,
    kind: "service-event",
    serviceCode: ev.service_code,
    ...(ev.feature_key ? { featureKey: ev.feature_key } : {}),
    occurredAt: new Date(ev.occurred_at * 1000).toISOString(),
    observedAt,
    title: ev.title,
    excerpt: ev.summary,
    ...(ev.url ? { url: ev.url } : {}),
    scopeKey: ev.scope_key,
    shareableTo: ev.scope_key === "public" ? ["*"] : [ev.scope_key],
  };
}

export async function executeEvent(ctx: RunContext, ev: ServiceEventRow): Promise<ExecuteOutcome> {
  const { ports } = ctx;
  const run = claimRun(ctx, "event", `event:${ev.id}:${ctx.rule.id}`, null);
  if (!run) return { status: "duplicate" };
  if (!ports.events.consume(ev.id, ctx.rule.id)) return finish(ctx, run, "skipped", "event already consumed", null);
  const material = eventToMaterial(ev, new Date(ports.nowMs()).toISOString());
  ports.runs.transition(run.run_id, ports.leaseOwner, ["claimed"], "material_selected", {
    source_ref: material.itemId,
    material_snapshot: JSON.stringify(material),
    reason: `service event ${ev.service_code}/${ev.event_kind}`,
  }, nowSecOf(ports));
  const committed = await renderAndCommit(ctx, run,
    { kind: "event", material: materialOf(material), replies: [], previousBotText: null, persona: null },
    { inReplyTo: null, conversationId: null });
  if (!committed.ok) return committed.outcome;
  openConversation(ctx, run, committed.chat, material.itemId);
  return { status: "posted", runId: run.run_id, chatMessageId: committed.chat.id };
}

// ─── reply / followup (会話) ────────────────────────────

/** 会話の最初の投稿の名乗り (返信・追投稿で引き継ぐ)。 */
function conversationPersona(ctx: RunContext, conv: RuleConversationRow): string | null {
  return personaOfChatMetadata(ctx.ports.chat.findById(conv.root_chat_id)?.metadata ?? null);
}

function conversationMaterial(ctx: RunContext, conv: RuleConversationRow): RenderMaterial | null {
  const root = ctx.ports.runs.findByChatMessage(conv.root_chat_id);
  if (!root?.material_snapshot) return null;
  try {
    return materialOf(JSON.parse(root.material_snapshot) as Material);
  } catch {
    return null;
  }
}

export async function executeReply(ctx: RunContext, conv: RuleConversationRow, inboundIds: number[]): Promise<ExecuteOutcome> {
  const { ports } = ctx;
  const run = claimRun(ctx, "reply", `reply:${inboundIds.join(",")}`, conv.conversation_id);
  if (!run) return { status: "duplicate" };
  const now = nowSecOf(ports);
  const ok = canReply({
    status: conv.status,
    expiresAt: conv.expires_at,
    lastBotAt: conv.last_bot_at,
    replyCount: conv.reply_count,
    unpromptedCount: conv.unprompted_count,
  }, ctx.config.followup, now);
  if (!ok.ok) {
    ports.conversations.settleInbound(inboundIds, "dropped", run.run_id, ok.reason);
    return finish(ctx, run, "skipped", ok.reason, null);
  }
  const replies = inboundIds
    .map((id) => ports.chat.findById(id)?.text)
    .filter((t): t is string => typeof t === "string");
  ports.runs.transition(run.run_id, ports.leaseOwner, ["claimed"], "material_selected",
    { reason: `reply to ${inboundIds.length} message(s)`, decision: JSON.stringify({ inboundIds }) }, now);
  const committed = await renderAndCommit(ctx, run, {
    kind: "reply",
    material: conversationMaterial(ctx, conv),
    replies,
    previousBotText: ports.chat.findById(conv.last_bot_message_id)?.text ?? null,
    persona: conversationPersona(ctx, conv),
  }, { inReplyTo: inboundIds[inboundIds.length - 1], conversationId: conv.conversation_id });
  if (!committed.ok) {
    // 生成失敗・停止でも同じ返信へ自動で何度も挑まない (結果は run に残る)。
    ports.conversations.settleInbound(inboundIds, "dropped", run.run_id, "reason" in committed.outcome ? committed.outcome.reason : "not posted");
    return committed.outcome;
  }
  ports.conversations.recordBotTurn(conv.conversation_id, committed.chat.id, "reply", nowSecOf(ports));
  ports.conversations.settleInbound(inboundIds, "answered", run.run_id, null);
  return { status: "posted", runId: run.run_id, chatMessageId: committed.chat.id };
}

export async function executeFollowup(ctx: RunContext, conv: RuleConversationRow): Promise<ExecuteOutcome> {
  const { ports } = ctx;
  const run = claimRun(ctx, "followup", `followup:${conv.conversation_id}:${conv.unprompted_count + 1}`, conv.conversation_id);
  if (!run) return { status: "duplicate" };
  ports.runs.transition(run.run_id, ports.leaseOwner, ["claimed"], "material_selected", { reason: "followup" }, nowSecOf(ports));
  // 生成直前に再評価する (閾値越え後の取り消し・返信の到着を反映する)。
  const recheck = observeFollowup(ctx, conv);
  if (!recheck.ok) return finish(ctx, run, "skipped", `followup re-check: ${recheck.reason}`, null);
  const committed = await renderAndCommit(ctx, run, {
    kind: "followup",
    material: conversationMaterial(ctx, conv),
    replies: [],
    previousBotText: ports.chat.findById(conv.last_bot_message_id)?.text ?? null,
    persona: conversationPersona(ctx, conv),
  }, { inReplyTo: conv.last_bot_message_id, conversationId: conv.conversation_id });
  if (!committed.ok) return committed.outcome;
  ports.conversations.recordBotTurn(conv.conversation_id, committed.chat.id, "followup", nowSecOf(ports));
  return { status: "posted", runId: run.run_id, chatMessageId: committed.chat.id };
}

/** 会話の現在の観測から追投稿の可否を出す。 */
export function observeFollowup(ctx: RunContext, conv: RuleConversationRow): { ok: boolean; reason: string } {
  const { ports } = ctx;
  const latest = ports.conversations.find(conv.conversation_id) ?? conv;
  const reactors = ports.reactions?.reactorsByMessage(latest.last_bot_message_id) ?? { distinct: 0, fine: 0, bad: 0 };
  return evaluateFollowup(
    {
      status: latest.status,
      expiresAt: latest.expires_at,
      lastBotAt: latest.last_bot_at,
      replyCount: latest.reply_count,
      unpromptedCount: latest.unprompted_count,
    },
    {
      directRepliesSinceLastBot: ports.conversations.inboundSince(latest.conversation_id, latest.last_bot_message_id),
      distinctReactors: reactors.distinct,
      fineReactors: reactors.fine,
      badReactors: reactors.bad,
      // 個別チャンネルの会話はそのチャンネルの発言だけを数える (本社の雑談で子会社へ追投稿しない)。
      laterHumanMessages: ports.chat.countHumanAfter(
        latest.channel, latest.last_bot_message_id, externalChannelOfMessage(ports.chat.findById(latest.root_chat_id)),
      ),
    },
    ctx.config.followup,
    nowSecOf(ports),
  );
}

export type { RunContext };
