import type Database from "better-sqlite3";
import { ChannelType, type Message } from "discord.js";

export const DISCUSSIONS = ["チーム相談", "企画相談", "プログラマー", "デザイナー", "サウンド", "プランナー"] as const;

/** Resolve an actual provisioned surface. Category membership alone never authorizes collection. */
export function discussionOwner(db: Database.Database, channel: string, category: string | null) {
  const row = db.prepare(`SELECT s.team_id, s.surface FROM team_surfaces s JOIN teams t ON t.id=s.team_id
    WHERE s.channel_id=? AND t.discord_category_id=?`).get(channel, category) as { team_id: string; surface: string } | undefined;
  return row && DISCUSSIONS.some(name => name === row.surface) ? row.team_id : null;
}

export function collectTeamMessage(db: Database.Database, ownsTeam: (id: string) => boolean, message: Message) {
  if (!message.inGuild() || message.author.bot || message.webhookId || message.system || !message.content) return false;
  const channel = message.channel;
  if (channel.type === ChannelType.PrivateThread) return false;
  const surface = channel.isThread() ? channel.parent : channel;
  if (!surface) return false;
  const team = discussionOwner(db, surface.id, surface.parentId);
  if (!team || !ownsTeam(team)) return false;
  db.prepare(`INSERT INTO team_discussion_messages(team_id, channel_id, message_id, author_id, content, revision)
    VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,message_id) DO UPDATE SET content=excluded.content,revision=excluded.revision
    WHERE excluded.revision >= team_discussion_messages.revision`).run(team, channel.id, message.id, message.author.id,
    message.content, message.editedTimestamp ?? message.createdTimestamp);
  return true;
}
