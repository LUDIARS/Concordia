import type Database from "better-sqlite3";
import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";

/** Explicit team option. A missing binding, history, or thread keeps the channel untouched. */
export async function retireEmptyTeamChannels(db: Database.Database, guild: Guild, team: string, category: string) {
  for (const name of ["コスト", "direction"]) {
    const row = db.prepare("SELECT channel_id FROM team_surfaces WHERE team_id=? AND surface=?").get(team, name) as { channel_id: string } | undefined;
    if (!row) continue;
    const channel = await guild.channels.fetch(row.channel_id, {force: true});
    if (channel?.type !== ChannelType.GuildText || channel.parentId !== category || channel.name !== name) continue;
    const bot = guild.members.me;
    if (!bot || !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageThreads])) continue;
    if ((await channel.threads.fetchActive()).threads.size) continue;
    if ((await channel.threads.fetchArchived({ type: "public", limit: 2 })).threads.size) continue;
    if ((await channel.threads.fetchArchived({ type: "private", fetchAll: true, limit: 2 })).threads.size) continue;
    if ((await channel.messages.fetch({limit: 1, cache: false})).size) continue;
    await channel.delete("Cc: remove empty superseded team channel");
    db.prepare("DELETE FROM team_surfaces WHERE team_id=? AND surface=? AND channel_id=?").run(team, name, row.channel_id);
  }
}
