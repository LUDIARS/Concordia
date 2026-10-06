/**
 * 削除済みのプライベート相談チャンネルを元の権限で作り直す (2026-10-06 neco 指示「相談きてたチャンネル復元して。
 * 元の権限で」)。
 *
 * Discord で消したチャンネルは戻せないので、同じ閲覧者 (除外済みを除く相談のメンバー) だけが見られる
 * チャンネルを相談のカテゴリに作り、Cc に残っている会話 (相談者の発言と最終回答) を再掲する。
 * 終了済みの相談は削除前と同じく書き込みを止め、再開・削除のボタンを出す (tech-consultation.md §7)。
 *
 * @implements SPEC-CONSULT-CLOSURE
 */
import { ChannelType, type Guild, type TextChannel } from "discord.js";
import type { PrivateConsultationRow, PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import type { SessionMessagesRepo } from "../db/session-messages-repo.js";
import { consultationTranscript } from "./consult-closure-wiring.js";
import { privateConsultChannelName } from "./consult-channel.js";
import { buildConsultClosedRow } from "./consult-modal.js";
import {
  createPrivateChannel,
  ensurePrivateCategory,
  lockPrivateChannel,
  type PrivateCategoryStore,
} from "./private-channel-discord.js";

/** 再掲の 1 投稿あたりの文字数 (Discord の 2000 に余白を残す)。 */
const POST_CHARS = 1800;

export interface RestoreConsultChannelDeps {
  guild: Guild;
  store: Pick<PrivateConsultationsRepo, "find" | "members" | "restoreChannel">;
  categoryStore: PrivateCategoryStore;
  sessionMessages: Pick<SessionMessagesRepo, "list">;
  log: { info(message: string): void; warn(message: string): void };
}

export type RestoreResult = "restored" | "reposted" | "not_deleted" | "not_found" | "channel_missing";

/** 再掲する本文を投稿単位に分ける。 1 発言が長ければ発言の中で切る。 */
export function restoredTranscriptPosts(lines: readonly { role: "user" | "assistant"; text: string }[]): string[] {
  const posts: string[] = [];
  let current = "";
  for (const line of lines) {
    const block = `**${line.role === "user" ? "相談者" : "回答"}**\n${line.text.trim()}`;
    const pieces = Array.from(block);
    for (let i = 0; i < pieces.length; i += POST_CHARS) {
      const piece = pieces.slice(i, i + POST_CHARS).join("");
      if (current && current.length + piece.length + 2 > POST_CHARS) {
        posts.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) posts.push(current);
  return posts;
}

export type RestoreMode = "rebuild" | "repost";

/**
 * - rebuild: 削除済みのチャンネルを元の閲覧者で作り直し、 中身を入れる。
 * - repost: 作り直し済みで中身が入らなかったチャンネル (途中で止まった復元) に中身を入れ直す。
 */
export async function restoreConsultChannel(
  deps: RestoreConsultChannelDeps,
  consultationId: string,
  mode: RestoreMode = "rebuild",
): Promise<RestoreResult> {
  const consultation = deps.store.find(consultationId);
  if (!consultation) return "not_found";
  if (mode === "repost") {
    if (consultation.channel_deleted_at !== null || !consultation.channel_id) return "channel_missing";
    const existing = await deps.guild.channels.fetch(consultation.channel_id).catch(() => null);
    if (existing?.type !== ChannelType.GuildText) return "channel_missing";
    await fillRestoredChannel(deps, consultation, existing);
    return "reposted";
  }
  if (consultation.channel_deleted_at === null) return "not_deleted";
  const viewerIds = deps.store.members(consultationId)
    .filter((member) => member.removed_at === null)
    .map((member) => member.platform_user_id);
  const categoryId = await ensurePrivateCategory(deps.guild, deps.categoryStore);
  const channel = await createPrivateChannel(deps.guild, {
    categoryId,
    name: privateConsultChannelName(new Date(consultation.created_at), consultation.id),
    viewerIds,
    reason: "private consultation channel restored",
  });
  deps.store.restoreChannel(consultationId, channel.id);
  deps.log.info(`private consultation channel recreated consultation=${consultationId} channel=${channel.id}`);
  await fillRestoredChannel(deps, consultation, channel);
  return "restored";
}

/**
 * 中身 (案内・会話の再掲・ボタン) を先に入れ、 書き込みの停止は最後にする。 停止は閲覧者ごとの権限編集で
 * Discord の制限に待たされうるので、 途中で止まっても中身は残るようにする (2026-10-06 の 2 件の取りこぼし)。
 */
async function fillRestoredChannel(
  deps: RestoreConsultChannelDeps,
  consultation: PrivateConsultationRow,
  channel: TextChannel,
): Promise<void> {
  const none = { parse: [] as [] };
  await channel.send({
    content: [
      `<@${consultation.requester_user_id}> のプライベート相談のチャンネルを復元しました (削除前と同じ閲覧者)。`,
      "Discord の元の投稿は戻せないため、Cc に残っている会話 (相談者の発言と回答) を再掲します。",
    ].join("\n"),
    allowedMentions: none,
  });
  const lines = consultation.session_id ? consultationTranscript(deps.sessionMessages, consultation.session_id) : [];
  for (const post of restoredTranscriptPosts(lines)) await channel.send({ content: post, allowedMentions: none });
  if (lines.length === 0) await channel.send({ content: "(再掲できる会話の記録はありませんでした)", allowedMentions: none });
  deps.log.info(`private consultation transcript reposted consultation=${consultation.id} posts=${lines.length}`);
  const closed = consultation.status === "closed";
  if (!closed) return;
  await channel.send({
    content: "このチャンネルは残ります。続きを相談するときは「セッションを再開」、不要になったら「チャンネルを削除」を押してください (再開は相談者本人、削除は相談者本人か管理者)。",
    components: [buildConsultClosedRow(consultation.id)],
    allowedMentions: none,
  });
  await lockPrivateChannel(channel);
  deps.log.info(`private consultation channel restored consultation=${consultation.id} channel=${channel.id}`);
}
