import type Database from "better-sqlite3";
import { ChannelType, type Message } from "discord.js";
import { acceptsDiscussionPost } from "../team-discussion-conversation/policy.js";

export const DISCUSSIONS = ["チーム相談", "企画相談", "プログラマー", "デザイナー", "サウンド", "プランナー"] as const;

/** Resolve an actual provisioned surface. Category membership alone never authorizes collection. */
export function discussionOwner(db: Database.Database, channel: string, category: string | null) {
  const row = db.prepare(`SELECT s.team_id, s.surface FROM team_surfaces s JOIN teams t ON t.id=s.team_id
    WHERE s.channel_id=? AND t.discord_category_id=?`).get(channel, category) as { team_id: string; surface: string } | undefined;
  return row && DISCUSSIONS.some(name => name === row.surface) ? row.team_id : null;
}

export function collectTeamMessage(db: Database.Database, ownsTeam: (id: string) => boolean, message: Message) {
  if (!message.inGuild()) return false;
  const channel = message.channel;
  const human = !(message.author.bot || message.webhookId || message.system);
  const publicChannel = channel.type !== ChannelType.PrivateThread;
  const surface = channel.isThread() ? channel.parent : channel;
  const team = human && publicChannel && surface ? discussionOwner(db, surface.id, surface.parentId) : null;
  const eligible = acceptsDiscussionPost({ human, publicChannel, ownedSurface: !!team && ownsTeam(team), hasContent: !!message.content });
  if (!eligible || !team || !surface) return false;
  db.prepare(`INSERT INTO team_discussion_messages(
    team_id, channel_id, message_id, author_id, content, revision, guild_id, surface_id, created_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(team_id,message_id) DO UPDATE SET
      guild_id=excluded.guild_id,surface_id=excluded.surface_id,created_at=excluded.created_at,
      content=CASE WHEN excluded.revision >= revision THEN excluded.content ELSE content END,
      revision=max(revision,excluded.revision)`).run(team, channel.id, message.id, message.author.id, message.content,
    message.editedTimestamp ?? message.createdTimestamp, message.guildId, surface.id, message.createdTimestamp);
  return true;
}
