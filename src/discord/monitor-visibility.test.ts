import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { describe, expect, it } from "vitest";
import { canShareMonitorSource } from "./monitor-visibility.js";

function surface(overwrites: Array<[string, bigint]> = [], publicView = false) {
  return { guild: { id: "guild", roles: { everyone: {} } }, type: ChannelType.GuildText,
    isThread: () => false,
    permissionsFor: () => new PermissionsBitField(publicView ? PermissionFlagsBits.ViewChannel : 0n),
    permissionOverwrites: { cache: new Collection(overwrites.map(([id, deny]) => [id,
      { id, type: 0, allow: new PermissionsBitField(0n), deny: new PermissionsBitField(deny) }])) },
  };
}

describe("canShareMonitorSource", () => {
  it("allows ordinary channels and public forum threads with the same audience", () => {
    const source = surface(); const monitor = surface();
    expect(canShareMonitorSource(source as never, monitor as never)).toBe(true);
    expect(canShareMonitorSource({ ...source, isThread: () => true, parent: source,
      type: ChannelType.PublicThread } as never, monitor as never)).toBe(true);
  });
  it("excludes other guilds, private threads, unknown sources and narrower overwrites", () => {
    const monitor = surface(); const source = surface([["private-role", PermissionFlagsBits.ViewChannel]]);
    expect(canShareMonitorSource(source as never, monitor as never)).toBe(false);
    expect(canShareMonitorSource(undefined, monitor as never)).toBe(false);
    expect(canShareMonitorSource({ ...monitor, type: ChannelType.PrivateThread } as never, monitor as never)).toBe(false);
    expect(canShareMonitorSource({ ...monitor, guild: { id: "other" } } as never, monitor as never)).toBe(false);
  });
  it("allows public sources even if monitor has a narrower audience", () => {
    expect(canShareMonitorSource(surface([], true) as never,
      surface([["everyone", PermissionFlagsBits.ViewChannel]]) as never)).toBe(true);
  });
});
