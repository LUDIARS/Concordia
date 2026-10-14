import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { ensureBountyReportChannel } from "./bounty-report-channel.js";

type FakeChannel = { id: string; name: string; type: ChannelType; parentId: string | null; setParent: ReturnType<typeof vi.fn> };

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

function channel(id: string, name: string, parentId: string | null, type = ChannelType.GuildText): FakeChannel {
  return { id, name, type, parentId, setParent: vi.fn(async () => undefined) };
}

function fakeGuild(channels: FakeChannel[]) {
  const cache = new Map(channels.map((c) => [c.id, c]));
  const create = vi.fn(async (options: { name: string; parent?: string }) => {
    const created = channel("new", options.name, options.parent ?? null);
    cache.set(created.id, created);
    return created;
  });
  return { guild: { channels: { cache, create } } as never, create };
}

const log = { warn: vi.fn() };

describe("bounty report channel", () => {
  it("カテゴリを持たないチャンネルとして作り、権限者の知らせ先が空ならそこへ入れる", async () => {
    const { guild, create } = fakeGuild([]);
    const config = fakeConfig();
    expect(await ensureBountyReportChannel({ guild, config, log })).toBe("new");
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ parent: expect.anything() }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "バグ報告", type: ChannelType.GuildText }));
    expect(config.get("bounty_authority_channel_id")).toBe("new");
  });

  it("カテゴリに入っている既存のチャンネルは作り直さず外へ出す", async () => {
    const existing = channel("ch", "バグ報告", "cat");
    const { guild, create } = fakeGuild([existing]);
    expect(await ensureBountyReportChannel({ guild, config: fakeConfig(), log })).toBe("ch");
    expect(create).not.toHaveBeenCalled();
    expect(existing.setParent).toHaveBeenCalledWith(null, expect.anything());
  });

  it("人が設定した知らせ先は上書きしない", async () => {
    const { guild } = fakeGuild([channel("ch", "バグ報告", null)]);
    const config = fakeConfig({ bounty_authority_channel_id: "other" });
    await ensureBountyReportChannel({ guild, config, log });
    expect(config.get("bounty_authority_channel_id")).toBe("other");
  });
});
