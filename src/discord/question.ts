import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Guild,
  type Interaction,
  type TextChannel,
} from "discord.js";
import type { DiscordCommandDeps } from "./commands.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";

function parseCustomId(customId: string): { questionId: number; answerIndex: number } | null {
  const m = /^q:(\d+):(\d+)$/.exec(customId);
  if (!m) return null;
  return { questionId: Number(m[1]), answerIndex: Number(m[2]) };
}

function buildQuestionEmbed(questionId: number, question: string, options: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("AskUserQuestion")
    .setDescription(question)
    .addFields(options.map((o, i) => ({ name: `${i}`, value: o })))
    .setFooter({ text: `question_id=${questionId}` })
    .setColor(0xf1c40f);
}

export async function postQuestion(
  input: {
    guild: Guild;
    sessionChannelsRepo: DiscordSessionChannelsRepo;
    pendingQuestionsRepo: DiscordPendingQuestionsRepo;
    log: { warn: (m: string) => void };
  },
  ev: { target_session_id: string; question_id: number; question: string; options: string[] },
): Promise<void> {
  const row = input.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  if (!row) return;
  const channel = await input.guild.channels.fetch(row.channel_id);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const tc = channel as TextChannel;
  const embed = buildQuestionEmbed(ev.question_id, ev.question, ev.options);
  const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
  if (ev.options.length <= 5) {
    const rowComp = new ActionRowBuilder<ButtonBuilder>();
    ev.options.forEach((opt, idx) => {
      rowComp.addComponents(new ButtonBuilder().setCustomId(`q:${ev.question_id}:${idx}`).setLabel(opt.slice(0, 80)).setStyle(ButtonStyle.Secondary));
    });
    components.push(rowComp);
  } else {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`qsel:${ev.question_id}`)
      .setPlaceholder("Select an answer")
      .addOptions(ev.options.slice(0, 25).map((o, i) => ({ label: o.slice(0, 100), value: String(i) })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  const msg = await tc.send({ embeds: [embed], components });
  input.pendingQuestionsRepo.setDiscordMessageId(ev.question_id, msg.id);
}

export async function dispatchQuestionInteraction(interaction: Interaction, deps: DiscordCommandDeps): Promise<void> {
  let questionId: number | null = null;
  let answerIndex: number | null = null;
  if (interaction.isButton()) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    questionId = parsed.questionId;
    answerIndex = parsed.answerIndex;
  } else if (interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith("qsel:")) return;
    questionId = Number(interaction.customId.slice("qsel:".length));
    answerIndex = Number(interaction.values[0] ?? "-1");
  } else {
    return;
  }
  const row = deps.pendingQuestionsRepo.findById(questionId);
  if (!row) {
    await interaction.reply({ content: "Question not found.", ephemeral: true });
    return;
  }
  if (row.answered_at !== null) {
    await interaction.reply({ content: "Already answered.", ephemeral: true });
    return;
  }
  const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${row.session_id}/answer-question`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question_id: questionId, answer_index: answerIndex }),
  });
  const json = await res.json().catch(() => ({} as { error?: unknown }));
  if (!res.ok) {
    const err = typeof (json as { error?: unknown }).error === "string"
      ? ((json as { error: string }).error)
      : `HTTP ${res.status}`;
    await interaction.reply({ content: `Answer failed: ${err}`, ephemeral: true });
    return;
  }
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update({ components: [] });
  }
}
