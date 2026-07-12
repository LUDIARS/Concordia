import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type GuildTextBasedChannel,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type Interaction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { formatAuthorName } from "./formatter.js";
import { readJsonObject } from "../shared/json-object.js";

const TRIGGERS = new Set(["control", "/control", "コントロール"]);

function activeSessionLines(
  sessionsRepo: SessionsRepo,
  channelsRepo: DiscordSessionChannelsRepo,
): string[] {
  const sessions = sessionsRepo.listSessions({ status: "active" }).slice(0, 5);
  if (sessions.length === 0) return ["(none)"];
  return sessions.map((s) => {
    let role = "-";
    const meta = readJsonObject(s.metadata);
    role = typeof meta.role_label === "string" ? meta.role_label : "-";
    const ch = channelsRepo.findBySessionId(s.id);
    const channelLabel = ch ? `<#${ch.channel_id}>` : "(no-channel)";
    return `• ${formatAuthorName(role, null)} • ${channelLabel} (${s.status})`;
  });
}

function buildControlPayload(
  sessionsRepo: SessionsRepo,
  channelsRepo: DiscordSessionChannelsRepo,
): { embeds: any[]; components: any[] } {
  const lines = activeSessionLines(sessionsRepo, channelsRepo).join("\n");
  const embed = {
    title: "🛠 Concordia Control",
    description: "Use buttons to spawn/end/rename/refresh sessions.",
    color: 0x5865f2,
    fields: [
      { name: "Active sessions", value: lines },
      { name: "Actions", value: "spawn / end-session / rename / refresh" },
    ],
    footer: { text: "Concordia" },
  };
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ctrl:spawn:claude").setLabel("New Claude").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ctrl:spawn:codex").setLabel("New Codex").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ctrl:spawn:gemini").setLabel("New Gemini").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ctrl:end-session").setLabel("End Session").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ctrl:rename").setLabel("Rename").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ctrl:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2] };
}

export function isControlTrigger(text: string): boolean {
  return TRIGGERS.has(text.trim().toLowerCase());
}

export async function postControlPanel(
  channel: GuildTextBasedChannel,
  sessionsRepo: SessionsRepo,
  channelsRepo: DiscordSessionChannelsRepo,
): Promise<void> {
  const payload = buildControlPayload(sessionsRepo, channelsRepo);
  await channel.send(payload);
}

async function callConcordia(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; error?: string; body?: any }> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (process.env.CONCORDIA_ADMIN_TOKEN) {
      headers.authorization = `Bearer ${process.env.CONCORDIA_ADMIN_TOKEN}`;
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, error: (j as any).error, body: j };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function sessionOptions(sessionsRepo: SessionsRepo): Array<{ label: string; value: string }> {
  return sessionsRepo.listSessions({ status: "active" }).slice(0, 25).map((s) => ({
    label: `${s.id.slice(0, 8)} (${s.branch ?? "-"})`,
    value: s.id,
  }));
}

export async function handleControlInteraction(
  interaction: Interaction,
  deps: {
    concordiaUrl: string;
    sessionsRepo: SessionsRepo;
    sessionChannelsRepo: DiscordSessionChannelsRepo;
    log?: { info: (m: string) => void; warn: (m: string) => void };
  },
): Promise<void> {
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (!id.startsWith("ctrl:")) return;
    deps.log?.info(`control interaction button id=${id} channel=${interaction.channelId ?? "-"} user=${interaction.user.id}`);
    if (id === "ctrl:refresh") {
      await interaction.update(buildControlPayload(deps.sessionsRepo, deps.sessionChannelsRepo));
      return;
    }
    if (id.startsWith("ctrl:spawn:")) {
      const provider = id.slice("ctrl:spawn:".length);
      deps.log?.info(`control spawn modal show provider=${provider} channel=${interaction.channelId ?? "-"}`);
      const modal = new ModalBuilder().setCustomId(`ctrl:spawn-modal:${provider}`).setTitle(`Spawn ${provider}`);
      const cwd = new TextInputBuilder().setCustomId("cwd").setLabel("cwd").setRequired(true).setStyle(TextInputStyle.Short);
      const args = new TextInputBuilder().setCustomId("args").setLabel("args (optional)").setRequired(false).setStyle(TextInputStyle.Paragraph);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(cwd), new ActionRowBuilder<TextInputBuilder>().addComponents(args));
      await interaction.showModal(modal);
      return;
    }
    if (id === "ctrl:end-session" || id === "ctrl:rename") {
      const options = sessionOptions(deps.sessionsRepo);
      if (options.length === 0) {
        await interaction.reply({ content: "No active sessions.", ephemeral: true });
        return;
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId(id === "ctrl:end-session" ? "ctrl:end-session:pick" : "ctrl:rename:pick")
        .setPlaceholder("Select session")
        .addOptions(options);
      await interaction.reply({ ephemeral: true, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] });
      return;
    }
    if (id.startsWith("ctrl:end-session:confirm:")) {
      const sid = id.slice("ctrl:end-session:confirm:".length);
      await interaction.deferUpdate();
      const r = await callConcordia(deps.concordiaUrl, "DELETE", `/v1/sessions/${sid}`);
      await interaction.editReply({ content: r.ok ? `Ended ${sid}` : `Failed: ${r.error ?? "unknown"}`, components: [] });
      return;
    }
  }
  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    deps.log?.info(`control interaction select id=${id} channel=${interaction.channelId ?? "-"} user=${interaction.user.id}`);
    if (id === "ctrl:end-session:pick") {
      const sid = interaction.values[0];
      const btn = new ButtonBuilder().setCustomId(`ctrl:end-session:confirm:${sid}`).setLabel(`Confirm end ${sid.slice(0, 8)}`).setStyle(ButtonStyle.Danger);
      await interaction.update({ components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)] });
      return;
    }
    if (id === "ctrl:rename:pick") {
      const sid = interaction.values[0];
      const modal = new ModalBuilder().setCustomId(`ctrl:rename-modal:${sid}`).setTitle("Rename session");
      const title = new TextInputBuilder().setCustomId("title").setLabel("title").setRequired(true).setStyle(TextInputStyle.Short).setMaxLength(30);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(title));
      await interaction.showModal(modal);
    }
  }
}

export async function handleControlModalSubmit(
  interaction: ModalSubmitInteraction | ChatInputCommandInteraction,
  deps: { concordiaUrl: string; log?: { info: (m: string) => void; warn: (m: string) => void } },
): Promise<void> {
  const cid = (interaction as ModalSubmitInteraction).customId;
  if (!cid?.startsWith("ctrl:")) return;
  deps.log?.info(`control modal submit id=${cid} channel=${interaction.channelId ?? "-"} user=${interaction.user.id}`);
  await (interaction as ModalSubmitInteraction).deferReply({ ephemeral: true });
  if (cid.startsWith("ctrl:spawn-modal:")) {
    const provider = cid.slice("ctrl:spawn-modal:".length);
    const cwd = (interaction as ModalSubmitInteraction).fields.getTextInputValue("cwd");
    const argsRaw = (interaction as ModalSubmitInteraction).fields.getTextInputValue("args");
    const args = argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [];
    deps.log?.info(`control spawn submit provider=${provider} has_cwd=${cwd ? 1 : 0} args_count=${args.length}`);
    const r = await callConcordia(deps.concordiaUrl, "POST", "/v1/admin/spawn-session", { provider, cwd, args });
    if (r.ok) {
      deps.log?.info(`control spawn submit ok provider=${provider}`);
    } else {
      deps.log?.warn(`control spawn submit failed provider=${provider} error=${r.error ?? "unknown"}`);
    }
    await (interaction as ModalSubmitInteraction).editReply({ content: r.ok ? "Spawn requested." : `Spawn failed: ${r.error ?? "unknown"}` });
    return;
  }
  if (cid.startsWith("ctrl:rename-modal:")) {
    const sid = cid.slice("ctrl:rename-modal:".length);
    const title = (interaction as ModalSubmitInteraction).fields.getTextInputValue("title");
    const r = await callConcordia(deps.concordiaUrl, "POST", `/v1/sessions/${sid}/title-suggestion`, { text: title });
    await (interaction as ModalSubmitInteraction).editReply({ content: r.ok ? "Rename requested." : `Rename failed: ${r.error ?? "unknown"}` });
  }
}
