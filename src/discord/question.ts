import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
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
    multi_select?: boolean;
    /** 起因者 (直近で指示した人間)。 discord のときだけ @メンションする。 */
    requester_platform?: "discord" | "slack";
    requester_user_id?: string;
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

  const selectOptions = options.slice(0, 25).map((o, i) => {
    const opt: { label: string; value: string; description?: string } = {
      label: o.label.slice(0, 100),
      value: String(i),
    };
    if (o.description) opt.description = o.description.slice(0, 100);
    return opt;
  });

  if (ev.multi_select) {
    // 複数選択: min1 / maxN のメニュー。確定はメニュー送信 (1 操作)。
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`qmul:${ev.question_id}`)
      .setPlaceholder("複数選択して送信")
      .setMinValues(1)
      .setMaxValues(Math.max(1, selectOptions.length))
      .addOptions(selectOptions);
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  } else if (options.length <= 5) {
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
      .addOptions(selectOptions);
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  // 「その他 (自由入力)」は常に別行のボタンで提供。押すと Modal が開く。
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`qoth:${ev.question_id}`)
        .setLabel("✏️ その他 (自由入力)")
        .setStyle(ButtonStyle.Primary),
    ),
  );

  // 起因者が discord ユーザなら @メンションして気付かせる (複数名同時利用での取りこぼし防止)。
  // mention は content に置き、 allowedMentions を当人だけに絞って @everyone 等の誤爆を防ぐ。
  const mentionId =
    ev.requester_platform === "discord" && ev.requester_user_id ? ev.requester_user_id : null;
  const payload: Parameters<TextChannel["send"]>[0] = mentionId
    ? {
        content: `<@${mentionId}> 確認をお願いします`,
        embeds: [embed],
        components,
        allowedMentions: { users: [mentionId] },
      }
    : { embeds: [embed], components };
  const msg = await tc.send(payload);
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

/** answer-question POST 用の body 形。単一 / 複数 / 自由文 のいずれか。 */
type AnswerBody =
  | { question_id: number; answer_index: number }
  | { question_id: number; answer_indices: number[] }
  | { question_id: number; other_text: string };

export async function dispatchQuestionInteraction(interaction: Interaction, deps: DiscordCommandDeps): Promise<void> {
  // 「その他」ボタン → Modal を開くだけ。HTTP なし・同期処理のみなので defer 不要。
  if (interaction.isButton() && interaction.customId.startsWith("qoth:")) {
    const qid = Number(interaction.customId.slice("qoth:".length));
    const row = deps.pendingQuestionsRepo.findById(qid);
    if (!row || row.answered_at !== null) {
      await interaction.reply({ content: "Already answered or not found.", ephemeral: true });
      return;
    }
    const modal = new ModalBuilder().setCustomId(`qothm:${qid}`).setTitle("その他 (自由入力)");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("other_text")
          .setLabel("回答")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  // Modal submit — deferReply してから HTTP。
  if (interaction.isModalSubmit() && interaction.customId.startsWith("qothm:")) {
    const questionId = Number(interaction.customId.slice("qothm:".length));
    const text = interaction.fields.getTextInputValue("other_text").trim();
    if (!text) {
      await interaction.reply({ content: "空の回答は送れません。", ephemeral: true });
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
    await interaction.deferReply({ ephemeral: true });
    const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${row.session_id}/answer-question`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question_id: questionId, other_text: text } satisfies AnswerBody),
    });
    const json = await res.json().catch(() => ({} as { error?: unknown; answer_text?: unknown }));
    if (!res.ok) {
      const err = typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : `HTTP ${res.status}`;
      await interaction.editReply({ content: `Answer failed: ${err}` });
      return;
    }
    const answerText = typeof (json as { answer_text?: unknown }).answer_text === "string"
      ? (json as { answer_text: string }).answer_text
      : "";
    if (interaction.message) {
      await interaction.message.edit({ components: [] }).catch(() => {});
    }
    await interaction.editReply({ content: `回答を送信しました: ${answerText}`.slice(0, 1900) });
    return;
  }

  // ボタン (q:xxx) / StringSelect — deferUpdate してから HTTP。
  let questionId: number;
  let body: AnswerBody;
  if (interaction.isButton()) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    questionId = parsed.questionId;
    body = { question_id: questionId, answer_index: parsed.answerIndex };
  } else if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith("qmul:")) {
      questionId = Number(interaction.customId.slice("qmul:".length));
      body = { question_id: questionId, answer_indices: interaction.values.map(Number) };
    } else if (interaction.customId.startsWith("qsel:")) {
      questionId = Number(interaction.customId.slice("qsel:".length));
      body = { question_id: questionId, answer_index: Number(interaction.values[0] ?? "-1") };
    } else {
      return;
    }
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
  await interaction.deferUpdate();
  const res = await fetch(`${deps.concordiaUrl}/v1/sessions/${row.session_id}/answer-question`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({} as { error?: unknown }));
  if (!res.ok) {
    const err = typeof (json as { error?: unknown }).error === "string"
      ? (json as { error: string }).error
      : `HTTP ${res.status}`;
    await interaction.followUp({ content: `Answer failed: ${err}`, ephemeral: true });
    return;
  }
  await interaction.editReply({ components: [] });
}
