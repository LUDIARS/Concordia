/** @implements spec/feature/staff-roster.md §3 — scoped one-time `/spawn` approval */
import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import type { DiscordCommandDeps, SpawnApprovalStore } from "./command-port.js";

export type { SpawnApprovalStore } from "./command-port.js";

const CUSTOM_ID_PREFIX = "spawn-approval:";
const REQUEST_TTL_MS = 15 * 60 * 1000;
const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/;

type SpawnApprovalDecision = "allow" | "deny";

export function isSpawnApprovalInteraction(interaction: Interaction): boolean {
  return interaction.isButton() && interaction.customId.startsWith(CUSTOM_ID_PREFIX);
}

export async function requestSpawnApproval(
  interaction: ChatInputCommandInteraction,
  deps: DiscordCommandDeps,
): Promise<void> {
  const store = deps.spawnApprovals;
  const executiveIds = validExecutiveIds(deps.listExecutiveDiscordUserIds?.() ?? []);
  if (!store || executiveIds.length === 0 || !interaction.guildId) {
    await interaction.reply({
      content: "このユーザーにはセッション起動権限がありません。許可を依頼できる執行役員が登録されていません。",
      ephemeral: true,
    });
    return;
  }

  pruneSpawnApprovals(store);
  const signature = spawnCommandSignature(interaction);
  const duplicate = [...store.entries()].find(([, action]) =>
    action.status === "pending"
    && action.requesterUserId === interaction.user.id
    && action.guildId === interaction.guildId
    && action.channelId === interaction.channelId
    && action.commandSignature === signature,
  );
  if (duplicate) {
    await interaction.reply({ content: "同じ /spawn の許可を執行役員へ申請済みです。", ephemeral: true });
    return;
  }

  const token = uniqueToken(store);
  store.set(token, {
    requesterUserId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    commandSignature: signature,
    status: "pending",
    createdAt: Date.now(),
  });
  const mentions = executiveIds.map((id) => `<@${id}>`).join(" ");
  try {
    await interaction.reply({
      content: `${mentions}\n<@${interaction.user.id}> が /spawn の一回許可を申請しています。` +
        " Allow 後、申請者が同じ内容の /spawn を15分以内に再実行すると許可を消費します。",
      components: [approvalButtons(token)],
      allowedMentions: { users: [...executiveIds, interaction.user.id] },
    });
  } catch (error) {
    // The request has no usable approval surface when Discord rejects the reply.
    store.delete(token);
    throw error;
  }
}

export function consumeApprovedSpawn(
  interaction: ChatInputCommandInteraction,
  store: SpawnApprovalStore | undefined,
): boolean {
  if (!store || !interaction.guildId) return false;
  pruneSpawnApprovals(store);
  const signature = spawnCommandSignature(interaction);
  const approved = [...store.entries()].find(([, action]) =>
    action.status === "approved"
    && action.requesterUserId === interaction.user.id
    && action.guildId === interaction.guildId
    && action.channelId === interaction.channelId
    && action.commandSignature === signature,
  );
  if (!approved) return false;
  store.delete(approved[0]);
  return true;
}

export async function dispatchSpawnApprovalInteraction(
  interaction: Interaction,
  deps: DiscordCommandDeps,
): Promise<void> {
  if (!interaction.isButton()) return;
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  const store = deps.spawnApprovals;
  const action = store?.get(parsed.token);
  if (!store || !action || Date.now() - action.createdAt > REQUEST_TTL_MS) {
    store?.delete(parsed.token);
    await interaction.reply({ content: "Spawn approval request expired or not found.", ephemeral: true });
    return;
  }
  if (
    interaction.guildId !== action.guildId
    || interaction.channelId !== action.channelId
    || interaction.user.id === action.requesterUserId
  ) {
    await interaction.reply({ content: "Spawn approval request does not match this interaction.", ephemeral: true });
    return;
  }

  if (parsed.decision === "allow") {
    store.set(parsed.token, { ...action, status: "approved", createdAt: Date.now() });
  } else {
    store.delete(parsed.token);
  }
  await interaction.update({
    content: `<@${action.requesterUserId}> /spawn は ${parsed.decision === "allow" ? "一回許可されました。同じ内容で再実行してください" : "拒否されました"} ` +
      `(by <@${interaction.user.id}>)`,
    components: [],
    allowedMentions: { users: [action.requesterUserId] },
  });
}

export function pruneSpawnApprovals(store: SpawnApprovalStore, now = Date.now()): void {
  for (const [token, action] of store) {
    if (now - action.createdAt > REQUEST_TTL_MS) store.delete(token);
  }
}

function validExecutiveIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => DISCORD_USER_ID_PATTERN.test(id)))];
}

function spawnCommandSignature(interaction: ChatInputCommandInteraction): string {
  return JSON.stringify(interaction.options.data.map((option) => canonicalOption(option)));
}

function canonicalOption(option: {
  name: string;
  type: number;
  value?: unknown;
  options?: readonly unknown[];
}): unknown {
  return {
    name: option.name,
    type: option.type,
    value: option.value ?? null,
    options: Array.isArray(option.options)
      ? option.options.map((child) => canonicalOption(child as Parameters<typeof canonicalOption>[0]))
      : [],
  };
}

function uniqueToken(store: SpawnApprovalStore): string {
  let token = randomUUID().replace(/-/g, "").slice(0, 16);
  while (store.has(token)) token = randomUUID().replace(/-/g, "").slice(0, 16);
  return token;
}

function parseCustomId(customId: string): { decision: SpawnApprovalDecision; token: string } | null {
  const match = /^spawn-approval:(allow|deny):([^:]+)$/.exec(customId);
  if (!match) return null;
  return { decision: match[1] as SpawnApprovalDecision, token: match[2]! };
}

function approvalButtons(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}allow:${token}`)
      .setLabel("Allow once")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}deny:${token}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
}
