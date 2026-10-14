/**
 * 相談のファイル受け渡し (Google Drive) の Discord コマンド (spec/feature/tech-consultation.md §6.4)。
 *
 * - `/consult files`: 相談者本人に、 自分の Drive のフォルダを Cc のサービスアカウントへ編集者で共有する手順を返す。
 * - `/consult files folder:<URL か ID>`: 相談者本人が共有したフォルダを相談に結び付ける (Cc が編集者として届くかを確かめる)。
 * - `/consult files-sync`: 相談者本人か権限者が、 受け取り (相談者 → 相談) と回答 (相談 → 相談者) を同期する。
 *
 * 判断と Drive の呼び出しは Cc の API (`/v1/consultations/:id/drive/*`) が持ち、 Bot は鍵を持たない。
 * 未設定なら相談チャンネルで「ファイル受け渡しは未設定」と伝えて終わる (相談は従来どおり続ける)。
 * Cc はフォルダを作らず、 相談者のメールアドレスも聞かない (共有の権限は相談者が Drive で持つ)。
 *
 * @implements SPEC-CONSULT-DRIVE-TRANSFER
 */

import { dirname, join } from "node:path";
import type { ChatInputCommandInteraction } from "discord.js";
import type { PrivateConsultationRow } from "../db/private-consultations-repo.js";
import type { DriveSyncResult, DriveTransferErrorCode } from "../consultation/drive-transfer-service.js";
import { transferRejectionText } from "../consultation/drive-transfer-policy.js";

export type ConsultDriveGuideResult = { ok: true; serviceAccountEmail: string } | { ok: false; error: string };
export type ConsultDriveLinkResult = { ok: true; folderUrl: string; relinked: boolean } | { ok: false; error: string };
export type ConsultDriveSyncResult =
  | ({ ok: true; folderUrl: string } & Pick<DriveSyncResult, "imported" | "delivered" | "skipped">)
  | { ok: false; error: string };

export interface ConsultDriveDeps {
  findByChannel(channelId: string): PrivateConsultationRow | null;
  guide(input: { consultationId: string; actorUserId: string }): Promise<ConsultDriveGuideResult>;
  link(input: { consultationId: string; actorUserId: string; folder: string }): Promise<ConsultDriveLinkResult>;
  sync(input: { consultationId: string; actorUserId: string }): Promise<ConsultDriveSyncResult>;
  /** 取り込んだファイルの場所をセッションへ伝える (inject)。 失敗しても同期の結果は返す。 */
  notifySession?(input: { sessionId: string; text: string; actorUserId: string; actorLabel: string }): Promise<void>;
}

export const DRIVE_NOT_CONFIGURED_TEXT = "ファイル受け渡しは未設定です。ファイルの受け渡しは使わず、このままチャットで相談を続けてください。";

const ERROR_TEXT: Readonly<Record<DriveTransferErrorCode, string>> = {
  consultation_not_found: "この相談が見つかりません。",
  not_requester: "受け渡しフォルダの設定は相談者本人だけが行えます。",
  not_allowed: "ファイルの同期は相談者本人か権限者だけが行えます。",
  transfer_unavailable: "この相談ではファイル受け渡しを使えません (相談窓口のセッションが動いていません)。",
  drive_not_configured: DRIVE_NOT_CONFIGURED_TEXT,
  invalid_folder: "Google Drive のフォルダの URL か ID として読めませんでした。フォルダを開いたときのアドレス (https://drive.google.com/drive/folders/…) を貼ってください。",
  folder_unreachable: "そのフォルダに Cc から届きませんでした。`/consult files` で案内したアドレスへ共有されているか確かめてください。",
  not_a_folder: "それはフォルダではありません (またはゴミ箱にあります)。フォルダの URL を貼ってください。",
  folder_read_only: "Cc が閲覧者として共有されています。共有の権限を「編集者」にしてからもう一度実行してください。",
  folder_linked_elsewhere: "そのフォルダは別の方の相談に結び付いています。自分で用意したフォルダを使ってください。",
  folder_not_linked: "まだ受け渡しフォルダが結び付いていません。相談者本人が `/consult files` の案内に沿って共有し、`/consult files folder:<URL>` で結び付けてください。",
  drive_failed: "Google Drive の操作に失敗しました。時間をおいてもう一度お試しください。",
};

export function consultDriveErrorText(error: string): string {
  return (ERROR_TEXT as Record<string, string>)[error] ?? `ファイル受け渡しに失敗しました: ${error}`;
}

/** 未設定はチャンネルの全員に伝える (相談の進め方が変わるため)。 それ以外の失敗は操作者にだけ返す。 */
function errorReply(error: string): { content: string; ephemeral: boolean } {
  return { content: consultDriveErrorText(error), ephemeral: error !== "drive_not_configured" };
}

/** 相談者が自分のフォルダを共有する手順 (操作者にだけ返す)。 */
export function formatShareGuide(serviceAccountEmail: string): string {
  return [
    "📁 ファイル受け渡しの準備 (相談者のあなただけに表示しています)",
    "1. 自分の Google Drive に、この相談用のフォルダを作ります。",
    `2. フォルダを「共有」し、次のアドレスを **編集者** で追加します: \`${serviceAccountEmail}\``,
    "3. フォルダの URL をコピーし、このチャンネルで `/consult files folder:<URL>` を実行します。",
    "見てほしい 3D モデル・音声をフォルダに置いて `/consult files-sync` を実行すると相談に取り込まれます。",
    "フォルダは相談が終わってもあなたの Drive に残ります (Cc は消しません)。不要になったら共有を外すか削除してください。",
  ].join("\n");
}

export async function handleConsultFiles(interaction: ChatInputCommandInteraction, deps: ConsultDriveDeps): Promise<void> {
  const consultation = interaction.channelId ? deps.findByChannel(interaction.channelId) : null;
  if (!consultation) {
    await interaction.reply({ content: "このチャンネルはプライベート相談のチャンネルではありません。", ephemeral: true });
    return;
  }
  const folder = interaction.options.getString("folder", false)?.trim() ?? "";
  await interaction.deferReply({ ephemeral: true });
  const actor = { consultationId: consultation.id, actorUserId: interaction.user.id };
  if (!folder) {
    const guide = await deps.guide(actor);
    if (!guide.ok) {
      await replyFailure(interaction, guide.error);
      return;
    }
    await interaction.editReply({ content: formatShareGuide(guide.serviceAccountEmail) });
    return;
  }
  const result = await deps.link({ ...actor, folder });
  if (!result.ok) {
    await replyFailure(interaction, result.error);
    return;
  }
  await interaction.editReply({ content: "フォルダを結び付けました。" });
  await interaction.followUp({
    content: [
      result.relinked ? "📁 この相談のファイル受け渡しフォルダを付け替えました。" : "📁 この相談のファイル受け渡しフォルダを結び付けました。",
      `<${result.folderUrl}>`,
      "相談者が共有したフォルダです。見てほしい 3D モデル・音声をこのフォルダに置いて `/consult files-sync` を実行してください。",
    ].join("\n"),
    allowedMentions: { parse: [] },
  });
}

async function replyFailure(interaction: ChatInputCommandInteraction, error: string): Promise<void> {
  const reply = errorReply(error);
  if (reply.ephemeral) {
    await interaction.editReply({ content: reply.content });
    return;
  }
  await interaction.editReply({ content: "ファイル受け渡しは未設定です。" });
  await interaction.followUp({ content: reply.content, allowedMentions: { parse: [] } });
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
