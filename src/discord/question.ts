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
import type {
  DiscordPendingQuestionsRepo,
  DiscordSessionChannelsRepo,
  PendingQuestionOption,
} from "../db/discord-repo.js";

function parseCustomId(customId: string): { questionId: number; answerIndex: number } | null {
  const m = /^q:(\d+):(\d+)$/.exec(customId);
  if (!m) return null;
  return { questionId: Number(m[1]), answerIndex: Number(m[2]) };
}

function normalizeOptions(
  raw: Array<string | { label: string; description?: string }>,
): PendingQuestionOption[] {
  return raw
    .map((o) =>
      typeof o === "string" ? ({ label: o } as PendingQuestionOption) : ({
        label: o.label,
        description: o.description?.trim() ? o.description.trim() : undefined,
      } as PendingQuestionOption),
    )
    .filter((o) => typeof o.label === "string" && o.label.length > 0);
}

function buildQuestionEmbed(
  questionId: number,
  question: string,
  options: PendingQuestionOption[],
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("AskUserQuestion")
    .setDescription(question)
    .addFields(
      options.map((o, i) => ({
        name: `${i}. ${o.label}`,
        // description があれば本文に出す。 無ければ label を再掲してフィールド空回避.
        value: (o.description ?? "—").slice(0, 1024),
      })),
    )
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
  ev: {
    target_session_id: string;
    question_id: number;
    question: string;
    options: Array<string | { label: string; description?: string }>;
  },
): Promise<void> {
  const row = input.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  if (!row) return;
  const channel = await input.guild.channels.fetch(row.channel_id);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const tc = channel as TextChannel;
  const options = normalizeOptions(ev.options);
  const embed = buildQuestionEmbed(ev.question_id, ev.question, options);
  const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
  if (options.length <= 5) {
    const rowComp = new ActionRowBuilder<ButtonBuilder>();
    options.forEach((opt, idx) => {
      rowComp.addComponents(
        new ButtonBuilder()
          .setCustomId(`q:${ev.question_id}:${idx}`)
          .setLabel(opt.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
      );
    });
    components.push(rowComp);
  } else {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`qsel:${ev.question_id}`)
      .setPlaceholder("Select an answer")
      .addOptions(
        options.slice(0, 25).map((o, i) => {
          const opt: { label: string; value: string; description?: string } = {
            label: o.label.slice(0, 100),
            value: String(i),
          };
          if (o.description) opt.description = o.description.slice(0, 100);
          return opt;
        }),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  const msg = await tc.send({ embeds: [embed], components });
  input.pendingQuestionsRepo.setDiscordMessageId(ev.question_id, msg.id);
}

/**
 * picker がローカル回答で解決したとき（question.resolved）、投稿済みの質問メッセージ
 * から components（ボタン/セレクト）を外して再クリックを防ぐ。message id は
 * discord_pending_questions に保持済み。best-effort。
 */
export async function resolveQuestionMessage(
  input: {
    guild: Guild;
    sessionChannelsRepo: DiscordSessionChannelsRepo;
    pendingQuestionsRepo: DiscordPendingQuestionsRepo;
    log: { warn: (m: string) => void };
  },
  ev: { target_session_id: string; question_id: number },
): Promise<void> {
  const row = input.pendingQuestionsRepo.findById(ev.question_id);
  if (!row || !row.discord_message_id) return;
  const ch = input.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  if (!ch) return;
  try {
    const channel = await input.guild.channels.fetch(ch.channel_id);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const msg = await (channel as TextChannel).messages.fetch(row.discord_message_id);
    await msg.edit({ components: [] });
  } catch (e) {
    input.log.warn(`resolveQuestionMessage failed qid=${ev.question_id}: ${(e as Error).message}`);
  }
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
