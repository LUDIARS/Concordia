import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";
import type { Guild, TextChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  createPrivateChannel,
  ensurePrivateCategory,
  grantPrivateViewer,
  lockPrivateChannel,
  privateChannelOverwrites,
  revokePrivateViewer,
  PRIVATE_CATEGORY_NAME,
} from "./private-channel-discord.js";

function fakeGuild() {
  const channels = new Map<string, { id: string; name: string; type: ChannelType }>();
  const created: Array<Record<string, unknown>> = [];
  let next = 1;
  const guild = {
    id: "guild-1",
    client: { user: { id: "bot-1" } },
    roles: { everyone: { id: "everyone-role" } },
    channels: {
      cache: { find: (fn: (c: { name: string; type: ChannelType }) => boolean) => [...channels.values()].find(fn) },
      fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        const channel = { id: `c-${next++}`, name: String(input.name), type: input.type as ChannelType };
        channels.set(channel.id, channel);
        return channel;
      }),
    },
  } as unknown as Guild;
  return { guild, created };
}

describe("private channels", () => {
  it("closes the channel in the creation request itself (CC-PRIVCH-INV-01)", async () => {
    const { guild, created } = fakeGuild();
    await createPrivateChannel(guild, { categoryId: "cat-1", name: "相談-20260930-abc123", viewerIds: ["111", "900", "111"], reason: "test" });
    const request = created[0]!;
    expect(request).toMatchObject({ type: ChannelType.GuildText, parent: "cat-1", name: "相談-20260930-abc123" });
    const overwrites = request.permissionOverwrites as Array<{ id: string; type: OverwriteType; allow?: bigint[]; deny?: bigint[] }>;
    expect(overwrites[0]).toEqual({ id: "everyone-role", type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] });
    expect(overwrites.map((o) => o.id)).toEqual(["everyone-role", "111", "900", "bot-1"]);
    expect(overwrites.find((o) => o.id === "111")?.allow).toContain(PermissionFlagsBits.SendMessages);
  });

  it("never lists the bot twice even if it is on the viewer list", () => {
    const { guild } = fakeGuild();
    const ids = privateChannelOverwrites(guild, ["bot-1", "111"]).map((o) => (o as { id: string }).id);
    expect(ids).toEqual(["everyone-role", "111", "bot-1"]);
  });

  it("creates the category once, closed to everyone, and reuses it", async () => {
    const { guild, created } = fakeGuild();
    let stored: string | null = null;
    const store = { categoryId: () => stored, setCategoryId: (id: string) => { stored = id; } };
    const first = await ensurePrivateCategory(guild, store);
    const second = await ensurePrivateCategory(guild, store);
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: PRIVATE_CATEGORY_NAME, type: ChannelType.GuildCategory });
  });

  it("takes over a saved legacy consultation category and renames it", async () => {
    const { guild, created } = fakeGuild();
    const setName = vi.fn(async () => undefined);
    (guild.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "old-cat", name: "プライベート相談", type: ChannelType.GuildCategory, setName });
    let stored: string | null = "old-cat";
    const id = await ensurePrivateCategory(guild, { categoryId: () => stored, setCategoryId: (next) => { stored = next; } });
    expect(id).toBe("old-cat");
    expect(setName).toHaveBeenCalledWith("プライベート", expect.any(String));
    expect(created).toHaveLength(0);
  });

  it("grants, revokes and locks viewers through member overwrites", async () => {
    const edit = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const channel = {
      guild: { client: { user: { id: "bot-1" } } },
      permissionOverwrites: {
        edit,
        delete: remove,
        cache: new Map([
          ["everyone-role", { id: "everyone-role", type: OverwriteType.Role }],
          ["111", { id: "111", type: OverwriteType.Member }],
          ["bot-1", { id: "bot-1", type: OverwriteType.Member }],
        ]),
      },
    } as unknown as TextChannel;

    await grantPrivateViewer(channel, "333");
    expect(edit).toHaveBeenCalledWith("333", expect.objectContaining({ ViewChannel: true, SendMessages: true }), expect.anything());
    await revokePrivateViewer(channel, "333");
    expect(remove).toHaveBeenCalledWith("333", expect.any(String));

    edit.mockClear();
    await lockPrivateChannel(channel);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("111", { SendMessages: false, AttachFiles: false }, expect.anything());
  });

  it("locks each viewer with its own deadline, keeps going past a stuck one and reports it (2026-10-06)", async () => {
    const edit = vi.fn(async (id: string) => {
      if (id === "stuck") await new Promise(() => undefined);
    });
    const channel = {
      id: "chan-1",
      guild: { client: { user: { id: "bot-1" } } },
      permissionOverwrites: {
        edit,
        cache: new Map([
          ["stuck", { id: "stuck", type: OverwriteType.Member }],
          ["222", { id: "222", type: OverwriteType.Member }],
          ["bot-1", { id: "bot-1", type: OverwriteType.Member }],
        ]),
      },
    } as unknown as TextChannel;
    const log = { info: vi.fn(), warn: vi.fn() };
    await expect(lockPrivateChannel(channel, { log, memberTimeoutMs: 10 })).rejects.toThrow("1 member(s)");
    expect(edit).toHaveBeenCalledWith("222", { SendMessages: false, AttachFiles: false }, expect.anything());
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("member=stuck"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("member=222"));
  });
});
