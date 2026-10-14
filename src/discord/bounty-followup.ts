/**
 * `/bug` の後続の操作 (spec/feature/bug-bounty.md §5 §7)。
 *
 * - `/bug amend id:<報告 id>`: 情報不足と判定された報告へ、本人がモーダルで書き足す (Cc の amend API)。
 * - `/bug appeal id:<報告 id> reason:<理由>`: 判定に 1 回だけ再審を求める。 決めるのは権限者 (WebUI)。
 * - `/bug close id:<報告 id> evidence:<根拠>`: 権限者 (本社の管理職以上) が根拠付きで手動クローズする。
 *
 * 応答はどれも本人にだけ返し、mention を許可しない。 Bot は台帳を直接書かず、Cc の API を通す。
 *
 * @implements SPEC-BOUNTY-APPEAL
 * @implements SPEC-BOUNTY-CLOSE
 * @implements SPEC-BOUNTY-TRIAGE
 */

import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { MAX_BOUNTY_TEXT_CHARS } from "../bounty/intake.js";
import { bountyErrorMessage, type BountyFlowDeps } from "./bounty-flow.js";
import { BOUNTY_CUSTOM_ID_PREFIX } from "./bounty-modal.js";

export const BOUNTY_AMEND_MODAL_PREFIX = `${BOUNTY_CUSTOM_ID_PREFIX}modal:amend:`;
const REPORT_ID = /^br_[A-Za-z0-9]{8,64}$/u;

const FOLLOWUP_MESSAGES: Readonly<Record<string, string>> = {
  not_awaiting_info: "この報告は情報不足の判定ではないため、追記できません。",
  amendment_empty: "追記する内容を書いてください。",
  not_appealable: "この報告は再審を求められる判定ではありません (対象外・重複・情報不足のときだけ)。",
  appeal_used: "再審は 1 報告につき 1 回までです。",
  reason_required: "理由を書いてください。",
  not_authority: "閉じられるのは本社の管理職以上だけです。",
  not_closable: "この報告は修正の段階にないため、閉じられません。",
  evidence_required: "閉じる根拠 (反映を確認した事実) を書いてください。",
  operator_unauthorized: "Bot の経路を確認できませんでした。管理者に連絡してください。",
};

function messageOf(error: string): string {
  return FOLLOWUP_MESSAGES[error] ?? bountyErrorMessage(error);
}

function readReportId(interaction: ChatInputCommandInteraction): string | null {
  const id = interaction.options.getString("id", true).trim();
  return REPORT_ID.test(id) ? id : null;
}

async function replyPrivately(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
}

/** `/bug amend`: 追記のモーダルを開く (最初の応答でしか出せないので defer しない)。 */
export async function handleBountyAmendOpen(interaction: ChatInputCommandInteraction): Promise<void> {
  const reportId = readReportId(interaction);
  if (!reportId) {
    await replyPrivately(interaction, "報告 id の形が正しくありません (br_ で始まる id)。");
    return;
  }
  const field = (id: "what_happened" | "repro_steps", label: string, required: boolean) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(required)
      .setMaxLength(MAX_BOUNTY_TEXT_CHARS));
  await interaction.showModal(new ModalBuilder()
    .setCustomId(`${BOUNTY_AMEND_MODAL_PREFIX}${reportId}`)
    .setTitle("バグ報告への追記")
    .addComponents(
      field("what_happened", "何が起きたか (書き足す内容)", true),
      field("repro_steps", "再現手順 (任意)", false),
    ));
}

/** 追記のモーダルの送信。 */
export async function handleBountyAmendSubmit(interaction: ModalSubmitInteraction, deps: BountyFlowDeps): Promise<void> {
  const reportId = interaction.customId.slice(BOUNTY_AMEND_MODAL_PREFIX.length);
  if (!REPORT_ID.test(reportId)) {
    await replyPrivately(interaction, "この送信を受け付けられませんでした。");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const result = await deps.amend({
    reportId,
    userId: interaction.user.id,
    whatHappened: interaction.fields.getTextInputValue("what_happened"),
    reproSteps: interaction.fields.getTextInputValue("repro_steps") ?? "",
  });
  await interaction.editReply({
    content: result.ok ? `報告 \`${reportId}\` へ追記しました。もう一度仕分けます。` : messageOf(result.error),
    allowedMentions: { parse: [] },
  });
}

/** `/bug appeal`: 判定への再審を 1 回だけ求める。 */
export async function handleBountyAppeal(interaction: ChatInputCommandInteraction, deps: BountyFlowDeps): Promise<void> {
  const reportId = readReportId(interaction);
  if (!reportId) {
    await replyPrivately(interaction, "報告 id の形が正しくありません (br_ で始まる id)。");
    return;
  }
  const reason = interaction.options.getString("reason", true);
  const result = await deps.appeal({ reportId, userId: interaction.user.id, reason });
  await replyPrivately(interaction, result.ok
    ? `報告 \`${reportId}\` の再審を申し出ました。権限者が決めたらこの受付口へ知らせます。`
    : messageOf(result.error));
}

/** `/bug close`: 権限者の手動クローズ。 Actio のタスクが done になっただけでは閉じない。 */
export async function handleBountyClose(interaction: ChatInputCommandInteraction, deps: BountyFlowDeps): Promise<void> {
  const reportId = readReportId(interaction);
  if (!reportId) {
    await replyPrivately(interaction, "報告 id の形が正しくありません (br_ で始まる id)。");
    return;
  }
  const evidence = interaction.options.getString("evidence", true);
  const result = await deps.close({ reportId, userId: interaction.user.id, evidence });
  await replyPrivately(interaction, result.ok ? `報告 \`${reportId}\` を反映済みとして閉じました。` : messageOf(result.error));
}
