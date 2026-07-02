import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ButtonInteraction,
  type Guild,
  type Interaction,
  type TextChannel,
} from "discord.js";
import type { DiscordCommandDeps } from "./commands.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";

type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionAction {
  sessionId: string;
  requestId: string;
  toolName: string;
  createdAt: number;
}

export type PermissionActionStore = Map<string, PermissionAction>;

const CUSTOM_ID_PREFIX = "perm:";
const STORE_TTL_MS = 15 * 60 * 1000;

/** 通知に載せる要約の上限 (行数 / 文字数)。 通知は「何をどこに」 が判れば足りる。 */
const SUMMARY_LINE_LIMIT = 2;
const SUMMARY_CHAR_LIMIT = 200;

function parseCustomId(customId: string): { decision: PermissionDecision; token: string } | null {
  const m = /^perm:(allow|deny|ask):([^:]+)$/.exec(customId);
  if (!m) return null;
  return { decision: m[1] as PermissionDecision, token: m[2] };
}

export function isPermissionInteraction(interaction: Interaction): boolean {
  return interaction.isButton() && interaction.customId.startsWith(CUSTOM_ID_PREFIX);
}

function makeToken(store: PermissionActionStore, action: Omit<PermissionAction, "createdAt">): string {
  prunePermissionActionStore(store);
  let token = randomUUID().replace(/-/g, "").slice(0, 16);
  while (store.has(token)) token = randomUUID().replace(/-/g, "").slice(0, 16);
  store.set(token, { ...action, createdAt: Date.now() });
  return token;
}

export function prunePermissionActionStore(store: PermissionActionStore, now = Date.now()): void {
  for (const [token, action] of store) {
    if (now - action.createdAt > STORE_TTL_MS) store.delete(token);
  }
}

/**
 * tool_input を通知向けに 2 行以内へ要約する。
 *
 * 旧実装は JSON.stringify(tool_input) を 1500 字まで貼っていて、 Bash/PowerShell の
 * 長いコマンドや Write の本文がまるごと通知を占拠していた (2026-07-02 ユーザ報告)。
 * Allow/Deny の判断に要るのは「どのツールで・何を・どこに」 だけなので、 ツール別に
 * 要点フィールドだけを抜き、 2 行 / 200 字に収める。
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const pick = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  let core: string | null;
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      core = pick(o.command);
      break;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      core = pick(o.file_path);
      break;
    case "WebFetch":
    case "WebSearch":
      core = pick(o.url) ?? pick(o.query);
      break;
    default:
      // 未知ツール: 代表的なフィールドを順に試し、 無ければ 1 行 JSON に落とす。
      core = pick(o.command) ?? pick(o.file_path) ?? pick(o.url) ?? pick(o.prompt) ?? pick(o.query);
      if (core === null) {
        try { core = JSON.stringify(input); } catch { core = String(input); }
      }
      break;
  }
  if (core === null) {
    try { core = JSON.stringify(input); } catch { core = String(input); }
  }
  return clipSummary(core ?? "");
}

/** 空行を除いた先頭 SUMMARY_LINE_LIMIT 行 / SUMMARY_CHAR_LIMIT 字に丸める。 省略時は … を付ける。 */
function clipSummary(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let out = lines.slice(0, SUMMARY_LINE_LIMIT).join("\n");
  if (out.length > SUMMARY_CHAR_LIMIT) out = `${out.slice(0, SUMMARY_CHAR_LIMIT).trimEnd()}…`;
  else if (lines.length > SUMMARY_LINE_LIMIT) out = `${out}\n…`;
  return out || "(empty)";
}

function formatToolInput(toolName: string, input: unknown): string {
  return `\`\`\`\n${summarizeToolInput(toolName, input)}\n\`\`\``;
}

function buildPermissionEmbed(ev: {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
  requester_platform?: "discord" | "slack";
  requester_user_id?: string;
}): EmbedBuilder {
  const cc =
    ev.requester_platform === "discord" && ev.requester_user_id
      ? `<@${ev.requester_user_id}>`
      : "none";
  return new EmbedBuilder()
    .setTitle("Tool Permission Request")
    .setColor(0xf1c40f)
    .addFields(
      { name: "Cc", value: cc.slice(0, 1024), inline: true },
      { name: "tool", value: ev.tool_name.slice(0, 1024), inline: true },
      { name: "request", value: ev.request_id.slice(0, 1024), inline: true },
      { name: "input", value: formatToolInput(ev.tool_name, ev.tool_input).slice(0, 1024), inline: false },
    );
}

function buildPermissionButtons(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`perm:allow:${token}`)
      .setLabel("Allow")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`perm:deny:${token}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`perm:ask:${token}`)
      .setLabel("Ask")
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function postPermissionRequest(
  input: {
    guild: Guild;
    sessionChannelsRepo: DiscordSessionChannelsRepo;
    permissionActions: PermissionActionStore;
    log: { warn: (m: string) => void };
  },
  ev: {
    target_session_id: string;
    request_id: string;
    tool_name: string;
    tool_input: unknown;
    requester_platform?: "discord" | "slack";
    requester_user_id?: string;
  },
): Promise<void> {
  const row = input.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  if (!row || row.status !== "active") return;
  const channel = await input.guild.channels.fetch(row.channel_id);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const token = makeToken(input.permissionActions, {
    sessionId: ev.target_session_id,
    requestId: ev.request_id,
    toolName: ev.tool_name,
  });
  const mentionId = ev.requester_platform === "discord" && ev.requester_user_id
    ? ev.requester_user_id
    : null;
  await (channel as TextChannel).send(mentionId
    ? {
        content: `Cc: <@${mentionId}> tool permission request`,
        embeds: [buildPermissionEmbed(ev)],
        components: [buildPermissionButtons(token)],
        allowedMentions: { users: [mentionId] },
      }
    : {
        embeds: [buildPermissionEmbed(ev)],
        components: [buildPermissionButtons(token)],
      });
}

export async function dispatchPermissionInteraction(
  interaction: Interaction,
  deps: DiscordCommandDeps,
): Promise<void> {
  if (!interaction.isButton()) return;
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  const store = deps.permissionActions;
  const action = store?.get(parsed.token);
  if (!store || !action) {
    await interaction.reply({ content: "Permission request expired or not found.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();
  const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${action.sessionId}/permission-response`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: action.requestId,
      decision: parsed.decision,
      reason: `discord:${interaction.user.id}`,
    }),
  });
  const json = await res.json().catch(() => ({})) as { error?: unknown };
  if (!res.ok) {
    const err = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    await interaction.followUp({ content: `Permission response failed: ${err}`, ephemeral: true });
    return;
  }

  store.delete(parsed.token);
  await editAnsweredPermissionCard(interaction, parsed.decision, interaction.user.tag);
}

async function editAnsweredPermissionCard(
  interaction: ButtonInteraction,
  decision: PermissionDecision,
  userTag: string,
): Promise<void> {
  const base = interaction.message.embeds?.[0];
  if (!base) {
    await interaction.editReply({ components: [] });
    return;
  }
  const embed = EmbedBuilder.from(base)
    .addFields({ name: "decision", value: `${decision} by ${userTag}`.slice(0, 1024) })
    .setColor(decision === "allow" ? 0x3ba55d : decision === "deny" ? 0xed4245 : 0x99aab5);
  await interaction.editReply({ embeds: [embed], components: [] });
}
