import type Database from "better-sqlite3";
import { ChannelType, type Guild, type TextChannel, type ThreadChannel } from "discord.js";
import { DISCUSSIONS, collectTeamMessage, discussionOwner } from "./team-discussion.js";

/** Recover public discussion history when the team bot reconnects. Never list other guild channels. */
export async function readTeamDiscussionHistory(db: Database.Database, guild: Guild, team: string, stopped: () => boolean) {
  const owns = (id: string) => id === team;
  async function read(channel: TextChannel | ThreadChannel) {
    if (channel.type === ChannelType.PrivateThread) return;
    const surface = channel.isThread() ? channel.parent : channel;
    if (!surface || discussionOwner(db, surface.id, surface.parentId) !== team) return;
    let before: string | undefined;
    while (!stopped()) {
      const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
      if (stopped()) return;
      for (const message of messages.values()) collectTeamMessage(db, owns, message);
      if (messages.size < 100) return;
      const oldest = [...messages.keys()].reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
      if (before === oldest) return;
      before = oldest;
    }
  }
  const rows = db.prepare("SELECT surface, channel_id FROM team_surfaces WHERE team_id=?").all(team) as { surface: string; channel_id: string }[];
  for (const row of rows) {
    if (stopped()) return;
    if (!DISCUSSIONS.some(s => s === row.surface)) continue;
    const surface = await guild.channels.fetch(row.channel_id);
    if (!surface || discussionOwner(db, surface.id, surface.parentId) !== team) continue;
    if (surface.type !== ChannelType.GuildForum && surface.type !== ChannelType.GuildText) continue;
    if (surface.type === ChannelType.GuildText) await read(surface);
    const active = await surface.threads.fetchActive();
    for (const thread of active.threads.values()) if (thread.parentId === surface.id) await read(thread);
    let before: Date | undefined;
    while (!stopped()) {
      const archived = await surface.threads.fetchArchived({ type: "public", before, limit: 100 }, false);
      for (const thread of archived.threads.values()) if (thread.parentId === surface.id) await read(thread);
      const last = archived.threads.last()?.archivedAt;
      if (!archived.hasMore || !last || (before && last >= before)) break;
      before = last;
    }
  }
}
