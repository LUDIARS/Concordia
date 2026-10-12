/**
 * 本社: 拠点セッションの質問カードで押されたボタン / 選択メニューを拠点へ返す (SPEC-FED-SITE-FORUM-PARITY)。
 *
 * 描画とカスタム ID の解釈は federation-question.ts (純関数)。 ここは Discord の interaction を受け、
 * 連合 ingress (`answer` 付き) で拠点へ渡し、 カードのボタンを外して誰が何を選んだかを残す。
 * 渡せなかった (拠点へ渡したスレッドではない・listener 停止中) ときはカードを残し、 押した本人にだけ理由を返す。
 */
import { MessageFlags, type ButtonInteraction, type Interaction, type StringSelectMenuInteraction } from "discord.js";
import { answeredNotice, isFederationQuestionCustomId, parseFederationQuestionAnswer, stripOptionCode } from "./federation-question.js";

export type FederationAnswerRoute = (input: {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorLabel: string;
  text: string;
  ts: number;
  answer: { question_id: number; option_indexes: number[] };
}) => boolean;

export function isFederationQuestionInteraction(interaction: Interaction): interaction is ButtonInteraction | StringSelectMenuInteraction {
  return (interaction.isButton() || interaction.isStringSelectMenu()) && isFederationQuestionCustomId(interaction.customId);
}

/** 押された部品の表示名 (コードを外した選択肢名)。 */
function selectedLabels(interaction: ButtonInteraction | StringSelectMenuInteraction, indexes: readonly number[]): string[] {
  if (interaction.isButton()) {
    const component = interaction.component as { label?: string | null };
    return [stripOptionCode(component.label ?? "")].filter(Boolean);
  }
  const options = interaction.component.options;
  return indexes.map((index) => stripOptionCode(options[index]?.label ?? String(index + 1)));
}

export async function handleFederationQuestionInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  route: FederationAnswerRoute,
  log: { warn(message: string): void },
): Promise<void> {
  const answer = parseFederationQuestionAnswer(interaction.customId, interaction.isStringSelectMenu() ? interaction.values : []);
  if (!answer || !interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "この回答は読み取れませんでした。", flags: MessageFlags.Ephemeral });
    return;
  }
  const labels = selectedLabels(interaction, answer.option_indexes);
  const authorLabel = (interaction.member && "nickname" in interaction.member ? interaction.member.nickname : null)?.trim()
    || interaction.user.globalName?.trim() || interaction.user.username;
  const routed = route({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: interaction.id,
    authorId: interaction.user.id,
    authorLabel,
    text: labels.join(" / ") || answer.option_indexes.map((index) => String(index + 1)).join(" / "),
    ts: Math.floor(interaction.createdTimestamp / 1000),
    answer,
  });
  if (!routed) {
    log.warn(`federation question answer not routed channel=${interaction.channelId} question=${answer.question_id}`);
    await interaction.reply({ content: "拠点へ回答を届けられませんでした (連合リンクが止まっている可能性があります)。少し待って押し直してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.update({ content: answeredNotice(authorLabel, labels), components: [] });
}
