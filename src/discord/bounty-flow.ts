/**
 * Discord からのバグ報告の流れ (spec/feature/bug-bounty.md §3 §4)。
 *
 * モーダル送信 → Cc の受付 API (台帳へ書いてから応答) → 本人にだけ結果を返す → チャンネルへ受付の告知。
 * 告知に出すのは報告 id と対象プロジェクトだけで、 本文は出さない (機微かどうかは仕分けが決めるまで
 * 機微として扱う)。 冪等キーは interaction id (CC-BOUNTY-INV-02)。 告知の失敗は受付を取り消さない (CC-INV-06)。
 *
 * 公開名の変更と取り下げも本人にだけ返す。 この面は本文をログへ出さない。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-REPORTER
 */

import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import type { BountyProject } from "../bounty/project-scope.js";
import { readBountyModal, type BountyModalValues } from "./bounty-modal.js";

/** 受付 API (POST /v1/bounty/...) の応答のうち、 この面が使う部分。 */
export interface BountyReceiptView {
  report_id: string;
  status: string;
  project: string | null;
  missing: string[];
  reporter: string;
  has_recipient: boolean;
}

export type BountyApiResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface BountyFlowDeps {
  /** この Bot (論理 runtime) の会社。 本社なら null。 */
  runtimeSubsidiaryId: string | null;
  /** 報告を受付 API へ出す。 `clientKey` は interaction id。 */
  submit(input: {
    clientKey: string;
    userId: string;
    guildId: string | null;
    channelId: string | null;
    values: BountyModalValues;
  }): Promise<BountyApiResult<{ receipt: BountyReceiptView; created: boolean }>>;
  setPublicName(input: { userId: string; publicName: string | null }): Promise<BountyApiResult<{ display: string }>>;
  withdraw(input: { reportId: string; userId: string }): Promise<BountyApiResult<{ receipt: BountyReceiptView }>>;
  /** この会社の範囲で報告できるプロジェクト (補完用)。 */
  projects(): ReadonlyArray<BountyProject>;
  /** 本人の今の公開名 (モーダルの既定値)。 未設定は null。 */
  currentPublicName(userId: string): string | null;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  unknown_project: "対象プロジェクトのコードが見つかりません。`/bug report` の project 候補から選ぶか、分からなければ空にしてください。",
  project_outside_company_scope: "このサーバの関係プロジェクトではないため、対象にできません。",
  public_name_invalid: "公開名は 32 文字までで、@ や < > ` 、リンク、改行を含められません。",
  text_too_long: "本文が長すぎます。4000 文字までにしてください。",
  report_not_found: "その報告 id は見つかりません。",
  not_reporter: "取り下げられるのは報告した本人だけです。",
  already_decided: "この報告は仕分けが済んでいるため、取り下げられません。",
  state_changed: "報告の状態が変わったため、取り下げられませんでした。もう一度確認してください。",
};

/** Discord のメッセージ本文の上限。 */
const MAX_MESSAGE_CHARS = 2000;

export function bountyErrorMessage(error: string): string {
  return ERROR_MESSAGES[error] ?? `受け付けられませんでした (${error})。時間をおいてもう一度お試しください。`;
}

/** チャンネルへ出す受付の告知。 報告 id と対象プロジェクトだけ (本文・報告者を出さない)。 */
export function bountyAnnouncement(receipt: Pick<BountyReceiptView, "report_id" | "project">): string {
  return `バグ報告 \`${receipt.report_id}\` を受け付けました (対象: ${receipt.project ?? "未特定"})。`;
}

export async function handleBountyModalSubmit(interaction: ModalSubmitInteraction, deps: BountyFlowDeps): Promise<void> {
  const values = readBountyModal(interaction);
  if (!values) {
    await interaction.reply({ content: "この送信を受け付けられませんでした。", ephemeral: true });
    return;
  }
  // 受付は台帳へ書いてから応答するので、 先に本人にだけ見える応答を確保する。
  await interaction.deferReply({ ephemeral: true });
  const submitted = await deps.submit({
    clientKey: interaction.id,
    userId: interaction.user.id,
    guildId: interaction.guildId ?? null,
    channelId: interaction.channelId ?? null,
    values,
  });
  if (!submitted.ok) {
    deps.log.warn(`bounty report refused user=${interaction.user.id} error=${submitted.error}`);
    // モーダルは閉じると入力が消える。 書いた内容を本人にだけ返し、 出し直せるようにする。
    await interaction.editReply({ content: refusalWithDraft(bountyErrorMessage(submitted.error), values) });
    return;
  }
  const { receipt, created } = submitted;
  await interaction.editReply({
    content: [
      `報告 \`${receipt.report_id}\` を受け付けました (対象: ${receipt.project ?? "未特定"})。仕分け結果はこのチャンネルへ返します。`,
      `公開名: ${receipt.reporter}`,
      receipt.has_recipient ? "" : "この報告は報奨の受取人を特定できていません。",
      "取り下げは `/bug withdraw`、公開名の変更は `/bug name` でできます。",
    ].filter(Boolean).join("\n"),
  });
  // 再送 (同じ interaction の受付済み) では告知を重ねない。
  if (!created) return;
  const channel = interaction.channel;
  if (!channel || !("send" in channel) || typeof channel.send !== "function") return;
  try {
    await channel.send({ content: bountyAnnouncement(receipt), allowedMentions: { parse: [] } });
  } catch (error) {
    deps.log.warn(`bounty announcement failed report=${receipt.report_id}: ${(error as Error).message}`);
  }
}

/** `/bug name`: 公開名を変える。 空なら匿名へ戻す。 本人の行だけが変わる。 */
export async function handleBountyName(interaction: ChatInputCommandInteraction, deps: BountyFlowDeps): Promise<void> {
  const name = interaction.options.getString("name")?.trim() ?? "";
  const result = await deps.setPublicName({ userId: interaction.user.id, publicName: name ? name : null });
  await interaction.reply({
    content: result.ok ? `公開名を「${result.display}」にしました。` : bountyErrorMessage(result.error),
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

/** `/bug withdraw`: 採用前の報告を本人が取り下げる。 */
export async function handleBountyWithdraw(interaction: ChatInputCommandInteraction, deps: BountyFlowDeps): Promise<void> {
  const reportId = interaction.options.getString("id", true).trim();
  const result = await deps.withdraw({ reportId, userId: interaction.user.id });
  await interaction.reply({
    content: result.ok ? `報告 \`${result.receipt.report_id}\` を取り下げました。` : bountyErrorMessage(result.error),
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function refusalWithDraft(message: string, values: BountyModalValues): string {
  const draft = [
    values.project ? `対象プロジェクト: ${values.project}` : "",
    `何が起きたか:\n${values.what_happened}`,
    values.repro_steps ? `再現手順:\n${values.repro_steps}` : "",
  ].filter(Boolean).join("\n\n");
  const head = `${message}\n\n入力した内容 (あなたにだけ表示しています):\n`;
  const room = MAX_MESSAGE_CHARS - head.length - 8;
  const body = draft.length > room ? `${draft.slice(0, Math.max(0, room - 1))}…` : draft;
  return `${head}\`\`\`\n${body.replace(/```/g, "'''")}\n\`\`\``;
}
