import type Database from "better-sqlite3";
import { ChannelType, type Message } from "discord.js";
import { acceptsDiscussionPost } from "../team-discussion-conversation/policy.js";
import { describeMessageAttachments } from "./message-attachments.js";

export const DISCUSSIONS = ["チーム相談", "企画相談", "プログラマー", "デザイナー", "サウンド", "プランナー"] as const;

/** Resolve an actual provisioned surface. Category membership alone never authorizes collection. */
export function discussionOwner(db: Database.Database, channel: string, category: string | null) {
  const row = db.prepare(`SELECT s.team_id, s.surface FROM team_surfaces s JOIN teams t ON t.id=s.team_id
    WHERE s.channel_id=? AND t.discord_category_id=?`).get(channel, category) as { team_id: string; surface: string } | undefined;
  return row && DISCUSSIONS.some(name => name === row.surface) ? row.team_id : null;
}

/**
 * セクションチャンネルの投稿を記録する。 画像・添付だけの投稿も捨てない (2026-11-26 neco 指示
 * 「画像だけの投稿を無視しないようにして」)。 添付は情報 (id・名前・種類・サイズ) だけを持ち、
 * 実物は取り込み時に投稿を取り直して保存する (CDN の URL は期限付きのため)。
 */
export function collectTeamMessage(db: Database.Database, ownsTeam: (id: string) => boolean, message: Message) {
  if (!message.inGuild()) return false;
  const channel = message.channel;
  const human = !(message.author.bot || message.webhookId || message.system);
  const publicChannel = channel.type !== ChannelType.PrivateThread;
  const surface = channel.isThread() ? channel.parent : channel;
  const team = human && publicChannel && surface ? discussionOwner(db, surface.id, surface.parentId) : null;
  const attachments = describeMessageAttachments(message.attachments?.values() ?? []);
  const hasContent = !!message.content || attachments.length > 0;
  const eligible = acceptsDiscussionPost({ human, publicChannel, ownedSurface: !!team && ownsTeam(team), hasContent });
  if (!eligible || !team || !surface) return false;
  db.prepare(`INSERT INTO team_discussion_messages(
    team_id, channel_id, message_id, author_id, content, revision, guild_id, surface_id, created_at, attachments_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(team_id,message_id) DO UPDATE SET
      guild_id=excluded.guild_id,surface_id=excluded.surface_id,created_at=excluded.created_at,
      content=CASE WHEN excluded.revision >= revision THEN excluded.content ELSE content END,
      attachments_json=CASE WHEN excluded.revision >= revision THEN excluded.attachments_json ELSE attachments_json END,
      revision=max(revision,excluded.revision)`).run(team, channel.id, message.id, message.author.id, message.content ?? "",
    message.editedTimestamp ?? message.createdTimestamp, message.guildId, surface.id, message.createdTimestamp,
    JSON.stringify(attachments));
  return true;
}
