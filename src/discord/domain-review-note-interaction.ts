/**
 * ドメインレビューの指摘の選択ダイアログで選ばれた値を backend へ渡す (spec domain-review-discord §4.2)。
 *
 * 判定 (本人か回答権限があるか・二重送信しないか) と Anatomia への送信は backend
 * (`POST /v1/domain-review/answers/:id/note-domain`) が持つ。 ここは interaction を受けて
 * 結果を表示するだけ。 選べたらダイアログを外して誰が何を選んだかを残し、
 * 選べなかったら押した本人にだけ理由を返してダイアログは残す。
 */
import { MessageFlags, type Interaction, type StringSelectMenuInteraction } from "discord.js";
import {
  domainReviewNoteChosenText,
  isDomainReviewNoteCustomId,
  parseDomainReviewNoteCustomId,
  type NoteDeliveryView,
} from "./domain-review-note-choice.js";

export type DomainReviewNoteChoiceCall = (input: {
  answerId: number;
  actorId: string;
  choice: string;
}) => Promise<{ note_delivery: NoteDeliveryView } | { error: string }>;

const CHOICE_ERROR_TEXT: Record<string, string> = {
  forbidden: "この選択は返信した本人か、レビュー回答の権限がある人だけができます。",
  answer_not_found: "対象の回答が見つかりませんでした。",
  not_a_domain_note: "この回答はドメインへの指摘ではありません。",
  invalid_choice: "選択肢を読み取れませんでした。",
};

export function isDomainReviewNoteInteraction(interaction: Interaction): interaction is StringSelectMenuInteraction {
  return interaction.isStringSelectMenu() && isDomainReviewNoteCustomId(interaction.customId);
}

export async function handleDomainReviewNoteInteraction(
  interaction: StringSelectMenuInteraction,
  choose: DomainReviewNoteChoiceCall,
  log: { warn(message: string): void },
): Promise<void> {
  const answerId = parseDomainReviewNoteCustomId(interaction.customId);
  const choice = interaction.values[0];
  if (answerId === null || !choice) {
    await interaction.reply({ content: CHOICE_ERROR_TEXT.invalid_choice!, flags: MessageFlags.Ephemeral });
    return;
  }
  // Anatomia への送信は Discord の 3 秒の応答期限を超えうるので、先に受領だけ返す。
  await interaction.deferUpdate();
  const result = await choose({ answerId, actorId: interaction.user.id, choice });
  if ("error" in result) {
    log.warn(`domain-review note choice not applied answer=${answerId} error=${result.error}`);
    await interaction.followUp({
      content: CHOICE_ERROR_TEXT[result.error] ?? `選択を反映できませんでした (${result.error})。少し待って選び直してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const actorLabel = (interaction.member && "nickname" in interaction.member ? interaction.member.nickname : null)?.trim()
    || interaction.user.globalName?.trim() || interaction.user.username;
  await interaction.editReply({
    content: domainReviewNoteChosenText(actorLabel, result.note_delivery),
    components: [],
    allowedMentions: { parse: [] },
  });
}
