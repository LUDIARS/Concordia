/**
 * 公開候補の判断カード (spec/feature/tech-consultation.md §5)。 相談チャンネルの中にだけ出す。
 *
 * ボタン: 公開する / 直して公開 / 公開しない / 取り下げ。 誰が押せるかは Cc の API
 * (publication-service) が判定する — 公開・公開しないは相談者本人、 取り下げは権限者 (CC-CONSULT-INV-04)。
 * Tabula が未設定なら公開系のボタンを出さず、 理由を添える (黙って押せない状態にしない)。
 *
 * @implements SPEC-CONSULT-PUBLISH
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ConsultationPublicationRow } from "../db/consultation-publications-repo.js";
import { CONSULT_CUSTOM_ID_PREFIX } from "./consult-modal.js";

export const CONSULT_PUBLICATION_PREFIX = `${CONSULT_CUSTOM_ID_PREFIX}pub:`;
export const CONSULT_PUBLICATION_EDIT_PREFIX = `${CONSULT_CUSTOM_ID_PREFIX}pubedit:`;

/** Discord の本文上限 (2000) に収めるための要約の表示上限。 全文は公開時に Tabula へ載る。 */
const MAX_CARD_SUMMARY = 1_400;
/** モーダルの入力欄は 4000 文字まで。 それを超える要約は「直して公開」を出さない (切り詰めて公開しない)。 */
export const MAX_EDITABLE_SUMMARY = 4_000;

export type PublicationAction = "publish" | "edit" | "decline" | "withdraw";
export type PublicationDecision = Exclude<PublicationAction, "edit">;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_requester: "公開するかどうかは相談者本人だけが決められます。",
  not_approver: "取り下げは権限者だけが行えます。",
  not_proposed: "この候補はすでに判断済みです。",
  publication_not_found: "候補が見つかりません。",
  tabula_not_configured: "Tabula の接続先が未設定のため公開できません。運用担当に設定を依頼してください。",
  tabula_failed: "Tabula への投稿に失敗しました。時間をおいてもう一度押してください。",
  invalid_proposal: "要約が長すぎるか空です。",
};

export function publicationErrorMessage(error: string): string {
  return ERROR_MESSAGES[error] ?? `処理できませんでした (${error})。`;
}

export function buildPublicationCard(publication: ConsultationPublicationRow, options: { tabulaReady: boolean }): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const summary = publication.summary.length > MAX_CARD_SUMMARY
    ? `${publication.summary.slice(0, MAX_CARD_SUMMARY)}\n… (続きは公開時にそのまま載ります)`
    : publication.summary;
  const lines = [
    "**公開候補** — 相談から書き直した要約です。公開するかどうかは相談者本人が決めます。",
    `**${publication.title}**`,
    summary,
  ];
  if (!options.tabulaReady) lines.push("", "Tabula の接続先が未設定のため、いまは公開できません。");
  const button = (action: PublicationAction, label: string, style: ButtonStyle, disabled = false) => new ButtonBuilder()
    .setCustomId(`${CONSULT_PUBLICATION_PREFIX}${publication.id}:${action}`)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button("publish", "公開する", ButtonStyle.Primary, !options.tabulaReady),
    button("edit", "直して公開", ButtonStyle.Secondary,
      !options.tabulaReady || publication.summary.length > MAX_EDITABLE_SUMMARY),
    button("decline", "公開しない", ButtonStyle.Danger),
    button("withdraw", "取り下げ (権限者)", ButtonStyle.Secondary),
  );
  return { content: lines.join("\n").slice(0, 2_000), components: [row] };
}

/** 判断後のカード本文。 ボタンは外す。 */
export function decidedPublicationContent(publication: ConsultationPublicationRow): string {
  const who = publication.decided_by ? `<@${publication.decided_by}>` : "不明";
  switch (publication.status) {
    case "published":
      return `**公開しました** (${who}): **${publication.title}**\n${publication.tabula_url ?? ""}`;
    case "declined":
      return `**公開しない** と決めました (${who}): ${publication.title}`;
    case "withdrawn":
      return `**取り下げ** ました (${who}): ${publication.title}`;
    default:
      return `**公開候補**: ${publication.title}`;
  }
}

export function parsePublicationButton(customId: string): { publicationId: string; action: PublicationAction } | null {
  if (!customId.startsWith(CONSULT_PUBLICATION_PREFIX)) return null;
  const [publicationId, action] = customId.slice(CONSULT_PUBLICATION_PREFIX.length).split(":");
  if (!publicationId || !["publish", "edit", "decline", "withdraw"].includes(action ?? "")) return null;
  return { publicationId, action: action as PublicationAction };
}

export function buildPublicationEditModal(publication: ConsultationPublicationRow): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${CONSULT_PUBLICATION_EDIT_PREFIX}${publication.id}`)
    .setTitle("直して公開")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId("summary")
      .setLabel("公開する本文")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(MAX_EDITABLE_SUMMARY)
      .setValue(publication.summary.slice(0, MAX_EDITABLE_SUMMARY))));
}

export interface PublicationInteractionDeps {
  findPublication(id: string): ConsultationPublicationRow | null;
  decide(input: {
    publicationId: string;
    decision: PublicationDecision;
    actorUserId: string;
    editedSummary?: string;
  }): Promise<{ ok: true; publication: ConsultationPublicationRow } | { ok: false; error: string }>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export async function handlePublicationButton(interaction: ButtonInteraction, deps: PublicationInteractionDeps): Promise<void> {
  const parsed = parsePublicationButton(interaction.customId);
  const publication = parsed ? deps.findPublication(parsed.publicationId) : null;
  if (!parsed || !publication) {
    await interaction.reply({ content: publicationErrorMessage("publication_not_found"), ephemeral: true });
    return;
  }
  if (parsed.action === "edit") {
    await interaction.showModal(buildPublicationEditModal(publication));
    return;
  }
  // 判断 (特に Tabula 投稿) は数秒かかりうるので先に応答を確保する。
  await interaction.deferUpdate();
  const result = await deps.decide({ publicationId: publication.id, decision: parsed.action, actorUserId: interaction.user.id });
  if (!result.ok) {
    await interaction.followUp({ content: publicationErrorMessage(result.error), ephemeral: true });
    return;
  }
  await interaction.editReply({ content: decidedPublicationContent(result.publication), components: [], allowedMentions: { parse: [] } });
}

export async function handlePublicationEditSubmit(
  interaction: ModalSubmitInteraction,
  deps: PublicationInteractionDeps,
): Promise<void> {
  const publicationId = interaction.customId.slice(CONSULT_PUBLICATION_EDIT_PREFIX.length);
  const editedSummary = interaction.fields.getTextInputValue("summary");
  await interaction.deferReply({ ephemeral: true });
  const result = await deps.decide({ publicationId, decision: "publish", actorUserId: interaction.user.id, editedSummary });
  if (!result.ok) {
    await interaction.editReply({ content: publicationErrorMessage(result.error) });
    return;
  }
  // 元のカードも判断済みに描き替える (モーダルはボタンから開いたので元メッセージを持つ)。
  if (interaction.message) {
    await interaction.message.edit({ content: decidedPublicationContent(result.publication), components: [], allowedMentions: { parse: [] } })
      .catch((error: unknown) => deps.log.warn(`publication card update failed: ${(error as Error).message}`));
  }
  await interaction.editReply({ content: `公開しました: ${result.publication.tabula_url ?? ""}` });
}
