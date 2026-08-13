import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Interaction,
} from "discord.js";
import type { ModelReviewOutcome } from "../model-review/contracts.js";
import type { RuntimeModelReviewApplyResult } from "../model-review/contracts.js";
import { callConcordia } from "./commands/_util.js";

const PREFIX = "mreview:";
const PENDING_TTL_MS = 10 * 60 * 1000;
const NO_MENTIONS = { parse: [] as never[] };

interface Proposal extends Extract<ModelReviewOutcome, { status: "proposal" }> {}

type PendingReview =
  | {
      kind: "spawn";
      actorUserId: string;
      request: Record<string, unknown>;
      proposal: Proposal;
      expiresAt: number;
    }
  | {
      kind: "runtime";
      actorUserId: null;
      sessionId: string;
      proposal: Proposal;
      expiresAt: number;
    };

const pending = new Map<string, PendingReview>();

export interface ModelReviewMessage {
  content: string;
  components: Array<ActionRowBuilder<ButtonBuilder>>;
  allowedMentions: typeof NO_MENTIONS;
}

export function isModelReviewInteraction(interaction: Interaction): boolean {
  return interaction.isButton() && interaction.customId.startsWith(PREFIX);
}

export function stageSpawnModelReview(input: {
  actorUserId: string;
  request: Record<string, unknown>;
  proposal: Proposal;
}): ModelReviewMessage {
  const token = stage({
    kind: "spawn",
    actorUserId: input.actorUserId,
    request: input.request,
    proposal: input.proposal,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  return renderProposal(token, input.proposal, "spawn");
}

export function stageRuntimeModelReview(input: {
  sessionId: string;
  proposal: Proposal;
}): ModelReviewMessage {
  const token = stage({
    kind: "runtime",
    actorUserId: null,
    sessionId: input.sessionId,
    proposal: input.proposal,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  return renderProposal(token, input.proposal, "task-change");
}

export async function dispatchModelReviewInteraction(
  interaction: ButtonInteraction,
  deps: {
    concordiaUrl: string;
    applyRuntimeReview?: (input: {
      sessionId: string;
      model: string;
      effort: string;
    }) => Promise<RuntimeModelReviewApplyResult>;
    log: { info: (message: string) => void; warn: (message: string) => void };
  },
): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  pruneExpired();
  const entry = pending.get(parsed.token);
  if (!entry) {
    await interaction.reply({
      content: "この確認は期限切れです。もう一度評価してください。",
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  if (entry.actorUserId && entry.actorUserId !== interaction.user.id) {
    await interaction.reply({
      content: "このSpawn確認は依頼した本人だけが操作できます。",
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  pending.delete(parsed.token);
  await interaction.deferUpdate();

  if (entry.kind === "spawn") {
    const request = parsed.action === "switch"
      ? applyProposalToSpawnRequest(entry.request, entry.proposal)
      : entry.request;
    const result = await callConcordia<{ ok: boolean; pid?: number; error?: string }>(
      deps.concordiaUrl,
      "POST",
      "/v1/admin/spawn-session",
      request,
    );
    const failed = "error" in result || !result.ok;
    const message = failed
      ? `Spawn failed: ${"error" in result ? result.error : (result.error ?? "unknown")}`
      : parsed.action === "switch"
        ? `Genius候補へ切り替えてSpawnしました: ${entry.proposal.proposedModel} / ${entry.proposal.proposedEffort}`
        : "現在のmodel / effortのままSpawnしました。";
    await interaction.editReply({ content: message, components: [], allowedMentions: NO_MENTIONS });
    return;
  }

  if (parsed.action === "keep") {
    await interaction.editReply({
      content: "現在のmodel / effortを維持します。",
      components: [],
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  if (!deps.applyRuntimeReview) {
    await interaction.editReply({
      content: "稼働中セッションの切替経路が利用できません。",
      components: [],
      allowedMentions: NO_MENTIONS,
    });
    return;
  }
  const result = await deps.applyRuntimeReview({
    sessionId: entry.sessionId,
    model: entry.proposal.proposedModel,
    effort: entry.proposal.proposedEffort,
  });
  await interaction.editReply({ content: result.message, components: [], allowedMentions: NO_MENTIONS });
}

export function renderModelReviewMiss(reason: string, trigger: "spawn" | "task-change"): string {
  const label = trigger === "spawn" ? "Session Spawn" : "task変更";
  const outcome = reason === "genius-no-hit" || reason === "genius-unavailable"
    ? "cache miss"
    : "review skipped";
  return `🧠 Genius ${outcome} (${label}, ${reason}) — model / effort は現在値を維持します。`;
}

function stage(entry: PendingReview): string {
  pruneExpired();
  const token = randomUUID().replaceAll("-", "");
  pending.set(token, entry);
  return token;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(token);
  }
}

function renderProposal(
  token: string,
  proposal: Proposal,
  trigger: "spawn" | "task-change",
): ModelReviewMessage {
  const current = `${proposal.currentModel ?? "provider default"} / ${proposal.currentEffort ?? "provider default"}`;
  const candidate = `${proposal.proposedModel} / ${proposal.proposedEffort}`;
  return {
    content: [
      `🧠 Genius hit — ${trigger === "spawn" ? "Spawn前" : "task変更後"}のmodel / effortを再評価しました。`,
      `現在: **${current}**`,
      `候補: **${candidate}**`,
      proposal.rationale,
    ].join("\n"),
    allowedMentions: NO_MENTIONS,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}switch:${token}`)
          .setLabel("候補へ切り替える")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`${PREFIX}keep:${token}`)
          .setLabel("現在設定を維持")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function parseCustomId(customId: string): { action: "switch" | "keep"; token: string } | null {
  const match = /^mreview:(switch|keep):([a-f0-9]{32})$/u.exec(customId);
  return match ? { action: match[1] as "switch" | "keep", token: match[2] } : null;
}

function applyProposalToSpawnRequest(
  request: Record<string, unknown>,
  proposal: Proposal,
): Record<string, unknown> {
  const provider = String(request.provider ?? "");
  const options = isRecord(request.options) ? { ...request.options } : {};
  if (provider === "claude") options.effort = proposal.proposedEffort;
  else options.model_reasoning_effort = proposal.proposedEffort;
  return { ...request, model: proposal.proposedModel, options };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
