import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { ensureBountyReportChannel } from "./bounty-report-channel.js";

type FakeChannel = { id: string; name: string; type: ChannelType; parentId: string | null };

function fakeConfig(initial: Record<string, string> = {}): DiscordConfigRepo {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
    compareAndSwap: () => false,
    all: () => Object.fromEntries(values),
  };
}

function fakeGuild(channels: FakeChannel[]) {
  const cache = new Map(channels.map((c) => [c.id, c]));
  const create = vi.fn(async (options: { name: string; parent: string }) => {
    const created = { id: "new", name: options.name, type: ChannelType.GuildText, parentId: options.parent };
    cache.set(created.id, created);
    return created;
  });
  return { guild: { channels: { cache, create } } as never, create };
}

const log = { warn: vi.fn() };
const category: FakeChannel = { id: "cat", name: "場所", type: ChannelType.GuildCategory, parentId: null };

describe("bounty report channel", () => {
  it("カテゴリ「場所」の中に作り、権限者の知らせ先が空ならそこへ入れる", async () => {
    const { guild, create } = fakeGuild([category]);
    const config = fakeConfig();
    expect(await ensureBountyReportChannel({ guild, config, log })).toBe("new");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "バグ報告", parent: "cat", type: ChannelType.GuildText }));
    expect(config.get("bounty_authority_channel_id")).toBe("new");
  });

  it("既にあるチャンネルは作り直さず、人が設定した知らせ先は上書きしない", async () => {
    const existing = { id: "ch", name: "バグ報告", type: ChannelType.GuildText, parentId: "cat" };
    const { guild, create } = fakeGuild([category, existing]);
    const config = fakeConfig({ bounty_authority_channel_id: "other" });
    expect(await ensureBountyReportChannel({ guild, config, log })).toBe("ch");
    expect(create).not.toHaveBeenCalled();
    expect(config.get("bounty_authority_channel_id")).toBe("other");
  });

  it("カテゴリ外の同名チャンネルは使わない", async () => {
    const outside = { id: "out", name: "バグ報告", type: ChannelType.GuildText, parentId: null };
    const { guild, create } = fakeGuild([category, outside]);
    expect(await ensureBountyReportChannel({ guild, config: fakeConfig(), log })).toBe("new");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("カテゴリが無ければ作らない", async () => {
    const { guild, create } = fakeGuild([]);
    const config = fakeConfig();
    expect(await ensureBountyReportChannel({ guild, config, log })).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(config.get("bounty_authority_channel_id")).toBeNull();
  });
});
