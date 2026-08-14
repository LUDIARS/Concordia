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
import { labelWithOptionCode } from "../shared/option-code.js";
import type { DiscordCommandDeps } from "./command-port.js";
import type { AnswerQuestionBody } from "../platform/answer-question.js";
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
        // `[A]` はテキスト返信で選択肢を指すためのコード (spec/feature/question-option-codes.md)。
        // Discord の field name は 256 文字まで。コード追加で既存の上限ちょうどの
        // ラベルが投稿失敗にならないよう、コード込みで制限する。
        name: labelWithOptionCode(i, o.label).slice(0, 256),
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
    /** relay 状態まで見た活性判定 (bot の isActiveDiscordSession)。 未注入なら面の有無だけで判定。 */
    isActiveSession?: (sessionId: string) => boolean;
    /**
     * チーム面ルーティング (team-card-routing.ts)。 対象セッションの team が確定していて
     * direction 面がある場合にその channel_id を返す。 null / 未注入なら現行どおり
     * セッションチャンネルへ出す。
     */
    resolveTeamChannelId?: (sessionId: string) => string | null;
  },
  ev: {
    target_session_id: string;
    question_id: number;
    question: string;
    options: Array<string | { label: string; description?: string }>;
    multi_select?: boolean;
    /** 委託子セッションの質問のとき、 親 (委託元) セッション。 子の面が無ければここへ出す。 */
    parent_session_id?: string;
    delegation_run_id?: string;
    /** 起因者 (直近で指示した人間)。 discord のときだけ @メンションする。 */
    requester_platform?: "discord" | "slack";
    requester_user_id?: string;
  },
): Promise<void> {
  // 子セッションの面が無い/非アクティブな場合は親 (委託元) の面へフォールバックする。
  // 従来は無言で捨てており、 委託子の質問が誰にも見えない「主人不在の Question」になっていた。
  const childActive = input.isActiveSession ? input.isActiveSession(ev.target_session_id) : true;
  const row = (childActive ? input.sessionChannelsRepo.findBySessionId(ev.target_session_id) : null)
    ?? (ev.parent_session_id ? input.sessionChannelsRepo.findBySessionId(ev.parent_session_id) : null);
  // チーム面 (direction) が引ければそちらへ出す。 面の fetch 失敗はセッションチャンネルへ
  // フォールバック (投稿先は setDiscordMessageId で保存されるため解決フローは追従する)。
  const teamChannelId = input.resolveTeamChannelId?.(ev.target_session_id) ?? null;
  const teamChannel = teamChannelId ? await input.guild.channels.fetch(teamChannelId).catch(() => null) : null;
  const routedTeamChannel =
    teamChannel && (teamChannel.type === ChannelType.GuildText || teamChannel.type === ChannelType.PublicThread)
      ? teamChannel
      : null;
  if (!routedTeamChannel && !row) return;
  const tc = routedTeamChannel ?? await (async () => {
    const channel = await input.guild.channels.fetch(row!.channel_id);
    return channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.PublicThread)
      ? channel
      : null;
  })();
  if (!tc) return;
  const options = normalizeOptions(ev.options);
  const embed = buildQuestionEmbed(ev.question_id, ev.question, options);
  const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];

  const selectOptions = options.slice(0, 25).map((o, i) => {
    const opt: { label: string; value: string; description?: string } = {
      label: labelWithOptionCode(i, o.label).slice(0, 100),
      value: String(i),
    };
    if (o.description) opt.description = o.description.slice(0, 100);
    return opt;
  });

  if (ev.multi_select && selectOptions.length > 0) {
    // 複数選択: min1 / maxN のメニュー。確定はメニュー送信 (1 操作)。
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`qmul:${ev.question_id}`)
      .setPlaceholder("複数選択して送信")
      .setMinValues(1)
      .setMaxValues(Math.max(1, selectOptions.length))
      .addOptions(selectOptions);
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  } else if (options.length > 0 && options.length <= 5) {
    const rowComp = new ActionRowBuilder<ButtonBuilder>();
    options.forEach((opt, idx) => {
      rowComp.addComponents(
        new ButtonBuilder()
          .setCustomId(`q:${ev.question_id}:${idx}`)
          .setLabel(labelWithOptionCode(idx, opt.label).slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
      );
    });
    components.push(rowComp);
  } else if (options.length > 5) {
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
  // #2: 質問カードは「直前の AI メッセージ (地の文)」の後に出す。 AskUserQuestion は
  // PreToolUse の早出しで question.posted が transcript リレーより先に来うるため、
  // 少し待って地の文の relay を先行させる (env で 0 にすれば即時)。
  if (QUESTION_POST_DELAY_MS > 0) await sleep(QUESTION_POST_DELAY_MS);
  const msg = await tc.send(payload);
  // 投稿先チャンネルも保存する — 親面フォールバック時、 解決 (ボタン除去) は子の面
  // ではなくこの値で辿る。
  input.pendingQuestionsRepo.setDiscordMessageId(ev.question_id, msg.id, tc.id);
}

/** 質問カードを地の文の後に出すための遅延 (ms)。 env CONCORDIA_QUESTION_POST_DELAY_MS で上書き。 */
const QUESTION_POST_DELAY_MS =
  Number(process.env.CONCORDIA_QUESTION_POST_DELAY_MS ?? "1200") || 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  // 投稿時に保存した実チャンネルを優先する (親面フォールバック時は子の面と異なる)。
  const channelId = row.discord_channel_id
    ?? input.sessionChannelsRepo.findBySessionId(ev.target_session_id)?.channel_id;
  if (!channelId) return;
  try {
    const channel = await input.guild.channels.fetch(channelId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread)) return;
    const msg = await channel.messages.fetch(row.discord_message_id);
    await msg.edit({ components: [] });
  } catch (e) {
    input.log.warn(`resolveQuestionMessage failed qid=${ev.question_id}: ${(e as Error).message}`);
  }
}

/** answer-question 用の body 形。単一 / 複数 / 自由文 のいずれか (control 側と共有)。 */
type AnswerBody = AnswerQuestionBody;

/** dispatch 内で使う正規化済み回答結果。 */
export type AnswerDispatchResult = { ok: true; answerText: string } | { ok: false; error: string };

const ANSWER_HTTP_RETRIES = 2;
const ANSWER_HTTP_RETRY_DELAY_MS = 300;

/**
 * 回答を確定させる。embedded (deps.answerQuestion あり) は in-process 直呼び、
 * worker (無し) は HTTP。**どちらの経路でも throw しない** — 2026-07-13 の
 * 「interaction handler failed: fetch failed」(self-fetch が backlog 溢れで落ちて
 * 例外が escape、ユーザに何も返らない) の再発防止。HTTP は 5xx/接続失敗のみ
 * リトライし、4xx (already_answered 等) は意味のあるエラーなので即返す。
 */
export async function sendAnswerForQuestion(
  deps: Pick<DiscordCommandDeps, "answerQuestion" | "concordiaUrl">,
  sessionId: string,
  body: AnswerBody,
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<AnswerDispatchResult> {
  if (deps.answerQuestion) {
    try {
      const r = await deps.answerQuestion(sessionId, body);
      return r.ok ? { ok: true, answerText: r.answer_text } : { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  const retries = opts.retries ?? ANSWER_HTTP_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? ANSWER_HTTP_RETRY_DELAY_MS;
  const url = `${deps.concordiaUrl}/v1/sessions/${encodeURIComponent(sessionId)}/answer-question`;
  let lastError = "unknown";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: unknown; answer_text?: unknown };
      if (res.ok) {
        return { ok: true, answerText: typeof json.answer_text === "string" ? json.answer_text : "" };
      }
      const err = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      if (res.status < 500) return { ok: false, error: err }; // 意味的エラーはリトライ無意味
      lastError = err;
    } catch (e) {
      lastError = `concordia unreachable: ${(e as Error).message}`;
    }
  }
  return { ok: false, error: lastError };
}

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
    const result = await sendAnswerForQuestion(
      deps,
      row.session_id,
      { question_id: questionId, other_text: text } satisfies AnswerBody,
    );
    if (!result.ok) {
      await interaction.editReply({ content: `Answer failed: ${result.error}` });
      return;
    }
    const answerText = result.answerText;
    if (interaction.message) {
      // 自由入力の回答もカードに残す (#3)。
      await interaction.message.edit(answeredCardEdit(interaction.message.embeds?.[0], answerText)).catch(() => {});
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
  const result = await sendAnswerForQuestion(deps, row.session_id, body);
  if (!result.ok) {
    await interaction.followUp({ content: `Answer failed: ${result.error}`, ephemeral: true });
    return;
  }
  // 選択結果をチャンネルに残す (#3): カードに「✅ 回答」を追記して可視化する。
  await interaction.editReply(answeredCardEdit(interaction.message?.embeds?.[0], result.answerText));
}

/**
 * 回答済みカードの編集ペイロード。 既存 embed に「✅ 回答」フィールドを足し、 緑にして
 * components を外す。 embed が取れなければ components 除去だけ行う。 #3 (選択結果の可視化)。
 */
function answeredCardEdit(
  baseEmbed: { toJSON?: () => unknown } | undefined | null,
  answerText: string,
): { embeds?: EmbedBuilder[]; components: [] } {
  const value = (answerText.trim() || "(送信済み)").slice(0, 1024);
  if (!baseEmbed) return { components: [] };
  try {
    const embed = EmbedBuilder.from(baseEmbed as Parameters<typeof EmbedBuilder.from>[0])
      .addFields({ name: "✅ 回答", value })
      .setColor(0x3ba55d);
    return { embeds: [embed], components: [] };
  } catch {
    return { components: [] };
  }
}
