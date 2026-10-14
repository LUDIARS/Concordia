/**
 * 相談のファイル受け渡し (Google Drive) の Discord コマンド (spec/feature/tech-consultation.md §6.4)。
 *
 * - `/consult files email:<Google アカウント>`: 相談者本人が Drive フォルダを作って自分に共有する。
 * - `/consult files-sync`: 相談者本人か権限者が、 受け取り (相談者 → 相談) と回答 (相談 → 相談者) を同期する。
 *
 * 判断と Drive の呼び出しは Cc の API (`/v1/consultations/:id/drive/*`) が持ち、 Bot は鍵を持たない。
 * 未設定なら相談チャンネルで「ファイル受け渡しは未設定」と伝えて終わる (相談は従来どおり続ける)。
 * 入力されたメールアドレスはチャンネルに出さない。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { dirname, join } from "node:path";
import type { ChatInputCommandInteraction } from "discord.js";
import type { PrivateConsultationRow } from "../db/private-consultations-repo.js";
import type { DriveSyncResult, DriveTransferErrorCode } from "../consultation/drive-transfer-service.js";
import { transferRejectionText } from "../consultation/drive-transfer-policy.js";

export type ConsultDriveOpenResult = { ok: true; folderUrl: string; created: boolean } | { ok: false; error: string };
export type ConsultDriveSyncResult =
  | ({ ok: true; folderUrl: string } & Pick<DriveSyncResult, "imported" | "delivered" | "skipped">)
  | { ok: false; error: string };

export interface ConsultDriveDeps {
  findByChannel(channelId: string): PrivateConsultationRow | null;
  open(input: { consultationId: string; actorUserId: string; email: string }): Promise<ConsultDriveOpenResult>;
  sync(input: { consultationId: string; actorUserId: string }): Promise<ConsultDriveSyncResult>;
  /** 取り込んだファイルの場所をセッションへ伝える (inject)。 失敗しても同期の結果は返す。 */
  notifySession?(input: { sessionId: string; text: string; actorUserId: string; actorLabel: string }): Promise<void>;
}

export const DRIVE_NOT_CONFIGURED_TEXT = "ファイル受け渡しは未設定です。ファイルの受け渡しは使わず、このままチャットで相談を続けてください。";

const ERROR_TEXT: Readonly<Record<DriveTransferErrorCode, string>> = {
  consultation_not_found: "この相談が見つかりません。",
  not_requester: "フォルダの共有は相談者本人だけが行えます。",
  not_allowed: "ファイルの同期は相談者本人か権限者だけが行えます。",
  transfer_unavailable: "この相談ではファイル受け渡しを使えません (相談窓口のセッションが動いていません)。",
  drive_not_configured: DRIVE_NOT_CONFIGURED_TEXT,
  invalid_email: "Google アカウントのメールアドレスとして読めませんでした。",
  folder_not_opened: "まだ受け渡しフォルダがありません。相談者本人が `/consult files email:<Google アカウント>` で作ってください。",
  drive_failed: "Google Drive の操作に失敗しました。時間をおいてもう一度お試しください。",
};

export function consultDriveErrorText(error: string): string {
  return (ERROR_TEXT as Record<string, string>)[error] ?? `ファイル受け渡しに失敗しました: ${error}`;
}

/** 未設定はチャンネルの全員に伝える (相談の進め方が変わるため)。 それ以外の失敗は操作者にだけ返す。 */
function errorReply(error: string): { content: string; ephemeral: boolean } {
  return { content: consultDriveErrorText(error), ephemeral: error !== "drive_not_configured" };
}

export async function handleConsultFiles(interaction: ChatInputCommandInteraction, deps: ConsultDriveDeps): Promise<void> {
  const consultation = interaction.channelId ? deps.findByChannel(interaction.channelId) : null;
  if (!consultation) {
    await interaction.reply({ content: "このチャンネルはプライベート相談のチャンネルではありません。", ephemeral: true });
    return;
  }
  const email = interaction.options.getString("email", true);
  await interaction.deferReply({ ephemeral: true });
  const result = await deps.open({ consultationId: consultation.id, actorUserId: interaction.user.id, email });
  if (!result.ok) {
    const reply = errorReply(result.error);
    if (reply.ephemeral) {
      await interaction.editReply({ content: reply.content });
    } else {
      await interaction.editReply({ content: "ファイル受け渡しは未設定です。" });
      await interaction.followUp({ content: reply.content, allowedMentions: { parse: [] } });
    }
    return;
  }
  await interaction.editReply({ content: "共有しました。Google から招待のメールが届きます。" });
  await interaction.followUp({
    content: [
      result.created ? "📁 この相談のファイル受け渡しフォルダを作りました。" : "📁 この相談のファイル受け渡しフォルダです。",
      `<${result.folderUrl}>`,
      "相談者のアカウントだけに共有しています。見てほしい 3D モデル・音声をこのフォルダに置いて `/consult files-sync` を実行してください。",
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

export async function handleConsultFilesSync(interaction: ChatInputCommandInteraction, deps: ConsultDriveDeps): Promise<void> {
  const consultation = interaction.channelId ? deps.findByChannel(interaction.channelId) : null;
  if (!consultation) {
    await interaction.reply({ content: "このチャンネルはプライベート相談のチャンネルではありません。", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const result = await deps.sync({ consultationId: consultation.id, actorUserId: interaction.user.id });
  if (!result.ok) {
    await interaction.editReply({ content: consultDriveErrorText(result.error), allowedMentions: { parse: [] } });
    return;
  }
  await interaction.editReply({
    content: formatSyncSummary(result, consultation.requester_user_id),
    allowedMentions: { users: result.delivered.length > 0 ? [consultation.requester_user_id] : [] },
  });
  if (result.imported.length > 0 && consultation.status === "open" && consultation.session_id && deps.notifySession) {
    await deps.notifySession({
      sessionId: consultation.session_id,
      text: formatSessionNotice(result.imported),
      actorUserId: interaction.user.id,
      actorLabel: interaction.user.displayName ?? interaction.user.id,
    }).catch(() => undefined);
  }
}

/** 同期の結果 (チャンネルに出す)。 Discord の 2000 文字に収める。 */
export function formatSyncSummary(
  result: Pick<DriveSyncResult, "imported" | "delivered" | "skipped"> & { folderUrl: string },
  requesterUserId: string,
): string {
  const lines: string[] = ["🔄 ファイル受け渡しを同期しました。"];
  if (result.imported.length > 0) {
    lines.push(`受け取り (${result.imported.length} 件): ${result.imported.map((file) => file.name).join(", ")}`);
  }
  if (result.delivered.length > 0) {
    lines.push(`<@${requesterUserId}> 回答のファイルをフォルダに置きました (${result.delivered.length} 件): ${result.delivered.map((file) => file.name).join(", ")}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`取り込まなかったもの: ${result.skipped.map((file) => `${file.name} (${file.reason === "already_exists" ? "同じ名前が取り込み済み" : transferRejectionText(file.reason)})`).join(", ")}`);
  }
  if (result.imported.length === 0 && result.delivered.length === 0 && result.skipped.length === 0) {
    lines.push("新しいファイルはありませんでした。");
  }
  lines.push(`フォルダ: <${result.folderUrl}>`);
  const text = lines.join("\n");
  return text.length > 2000 ? `${text.slice(0, 1990)}\n…(省略)` : text;
}

/** セッションへの知らせ。 取り込んだ場所だけを伝え、 回答のファイルを置く場所を案内する。 */
export function formatSessionNotice(imported: DriveSyncResult["imported"]): string {
  // 取り込み先は <データフォルダ>/transfer/incoming/<名前>。 回答は隣の outgoing。
  const outgoing = imported[0] ? join(dirname(dirname(imported[0].path)), "outgoing") : "";
  return [
    "相談者からファイルが届きました (Google Drive のファイル受け渡し)。",
    ...imported.map((file) => `- ${file.kind === "model" ? "3D モデル" : "音声"}: ${file.path}`),
    outgoing ? `直したファイルを返すときは ${outgoing} に置いてください。相談者か権限者が /consult files-sync を実行すると相談者に届きます。` : "",
  ].filter(Boolean).join("\n");
}
