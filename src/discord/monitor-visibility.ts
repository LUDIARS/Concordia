import { ChannelType, PermissionFlagsBits, type GuildBasedChannel, type TextChannel } from "discord.js";

/** Only share a source when its entire audience includes the monitor audience. */
export function canShareMonitorSource(source: GuildBasedChannel | undefined, monitor: TextChannel): boolean {
  if (!source || source.guild.id !== monitor.guild.id || source.type === ChannelType.PrivateThread) return false;
  const channel = source.isThread() ? source.parent : source;
  if (!channel || !("permissionOverwrites" in channel)) return false;
  const view = PermissionFlagsBits.ViewChannel;
  if (channel.permissionsFor(channel.guild.roles.everyone)?.has(view)
    && !channel.permissionOverwrites.cache.some(o => o.deny.has(view))) return true;
  const fingerprint = (c: typeof channel | TextChannel): string => JSON.stringify(
    [...c.permissionOverwrites.cache.values()].map(o => [o.id, o.type, o.allow.bitfield.toString(), o.deny.bitfield.toString()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  return fingerprint(channel) === fingerprint(monitor);
}
