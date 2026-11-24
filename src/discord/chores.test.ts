import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild, type Message, type Interaction } from "discord.js";
import { acceptReplyText, choreCard, choreCompletionReply, startChoresDiscord } from "./chores.js";
import type { Chore } from "../chores/domain.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const row: Chore = { id: "00000000-0000-4000-8000-000000000001", request_key: "a", prompt: "依頼 @everyone", provider: "claude",
  status: "succeeded", cwd: "/chores/a", output: "結果", error: null, spawn_id: null, created_at: 1, updated_at: 2,
  revision: 3, delivered_revision: 0, discord_message_id: null };
function memoryConfig(): DiscordConfigRepo {
  const values = new Map<string, string>([["chores_channel_id", "channel"], ["chores_forum_id", "forum"]]);
  return {
    get: key => values.get(key) ?? null, set: (key, value) => { values.set(key, value); },
    delete: key => { values.delete(key); }, all: () => Object.fromEntries(values),
    compareAndSwap(key, expected, value) {
      if ((values.get(key) ?? null) !== expected) return false;
      if (value === null) values.delete(key); else values.set(key, value);
      return true;
    },
  };
}
function prepareGuild(guild: Guild): Guild {
  const card = { id: "forum-card", author: { id: "bot" },
    components: [{ components: [{ customId: `chore:${row.id}:ok` }] }], edit: vi.fn(async () => card) };
  const thread = { id: "work-thread", guildId: guild.id, parentId: "forum", isThread: () => true,
    fetchStarterMessage: vi.fn(async () => card), messages: { fetch: vi.fn(async () => card) }, send: vi.fn(async () => card) };
  const forum = { id: "forum", type: ChannelType.GuildForum, name: "雑務課", threads: { create: vi.fn(async () => thread) } };
  guild.channels.cache.set("forum", forum as never);
  for (const c of guild.channels.cache.values()) if (c.type === ChannelType.GuildText) {
    Object.assign(c, { setName: vi.fn(async () => c), isThread: () => false });
  }
  Object.assign(guild.channels, { fetch: vi.fn(async (id: string) => id === thread.id ? thread : guild.channels.cache.get(id)) });
  if (!guild.client) Object.assign(guild, { client: { user: { id: "bot" } } });
  return guild;
}
describe("Discord chores", () => {
  it.each(["succeeded", "failed", "interrupted"] as const)("notifies the original requester on first %s delivery only", (status) => {
    const run = { ...row, status, request_key: "discord:123:456" };
    expect(choreCompletionReply(run, "123")).toEqual({
      reply: { messageReference: "456", failIfNotExists: false },
      allowedMentions: { parse: [], repliedUser: true },
    });
    expect(choreCompletionReply({ ...run, discord_message_id: "789" }, "123").reply).toBeUndefined();
    expect(choreCompletionReply({ ...run, delivered_revision: 3 }, "123").allowedMentions.repliedUser).toBe(false);
  });
  it("does not guess recipients for web requests, other guilds or follow-up states", () => {
    for (const run of [row, { ...row, request_key: "discord:999:456" },
      { ...row, request_key: "discord:123:456", status: "acknowledged" as const },
      { ...row, request_key: "discord:123:456", status: "continued" as const }]) {
      expect(choreCompletionReply(run, "123")).toEqual({ allowedMentions: { parse: [], repliedUser: false } });
    }
  });
  it("sends one notifying result reply and updates its saved card after acknowledgement fails", async () => {
    vi.useFakeTimers();
    const run = { ...row, request_key: "discord:123:456" };
    let acknowledged = false;
    let attempts = 0;
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/deliveries")) return new Response(JSON.stringify({ runs: acknowledged ? [] : [run] }));
      attempts++;
      if (attempts === 1) return new Response(JSON.stringify({ error: "temporary" }), { status: 503 });
      acknowledged = true;
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetcher);
    const posted = { id: "789", edit: vi.fn(async () => posted) };
    const send = vi.fn(async () => posted);
    const channel = { id: "channel", type: ChannelType.GuildText, send, messages: { fetch: vi.fn(async () => posted) } };
    const guild = prepareGuild({ id: "123", channels: { cache: new Map([["channel", channel]]) } } as unknown as Guild);
    const surface = await startChoresDiscord({ guild, config: memoryConfig(),
      baseUrl: "http://cc", log: { warn: vi.fn() } });
    try {
      await vi.advanceTimersByTimeAsync(9000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(posted.edit).toHaveBeenCalledTimes(1);
      expect(posted.edit).toHaveBeenCalledWith(choreCard(run));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ reply: { messageReference: "456", failIfNotExists: false },
        allowedMentions: { parse: [], repliedUser: true }, enforceNonce: true }));
      expect(acknowledged).toBe(true);
    } finally { surface.stopChores(); }
  });

  it("renders actual OK/Continue controls and suppresses mentions", () => {
    const card = choreCard(row);
    expect(card.allowedMentions.parse).toEqual([]);
    expect(card.components[0].toJSON().components.map(b => "label" in b ? b.label : null)).toEqual(["OK", "Continue"]);
    expect(card.components[0].toJSON().components.every(b => !b.disabled)).toBe(true);
    expect(choreCard({ ...row, status: "continued" }).components[0].toJSON().components.every(b => b.disabled)).toBe(true);
  });
  it("leaves the window channel to the request desk: no create, rename or move (Cc v5)", async () => {
    const setParent = vi.fn(async () => undefined);
    const channel = { id: "channel", type: ChannelType.GuildText, name: "依頼窓口", parentId: null, setParent };
    const guild = prepareGuild({ id: "guild", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const create = vi.fn();
    Object.assign(guild.channels, { create });
    const surface = await startChoresDiscord({ guild, config: memoryConfig(), baseUrl: "http://cc", log: { warn: vi.fn() } });
    try {
      expect(setParent).not.toHaveBeenCalled();
      expect((channel as unknown as { setName: ReturnType<typeof vi.fn> }).setName).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally { surface.stopChores(); }
  });

  it("no longer takes new chores from the window or the forum (Cc v5: the desk takes them)", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(JSON.stringify({ runs: [] })));
    vi.stubGlobal("fetch", fetcher);
    const guild = prepareGuild({ id: "guild", channels: { cache: new Map([["channel", { id: "channel", type: ChannelType.GuildText }]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const surface = await startChoresDiscord({ guild, config: memoryConfig(), baseUrl: "http://cc", allowed: () => true, log: { warn: vi.fn() } });
    const message = { guildId: "guild", channelId: "channel", id: "message", author: { id: "human", bot: false }, webhookId: null,
      channel: { isThread: () => false }, content: "[codex] 依頼", reply: vi.fn() } as unknown as Message;
    try {
      expect(surface.handlesMessage(message)).toBe(false);
      expect(surface.handlesThread({ guildId: "guild", parentId: "forum" } as never)).toBe(false);
      await surface.message(message);
      expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    } finally { surface.stopChores(); }
  });
  it("rejects copied buttons outside the dedicated channel", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const channel = { id: "channel", type: ChannelType.GuildText };
    const guild = prepareGuild({ id: "guild", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const surface = await startChoresDiscord({ guild, config: memoryConfig(),
      baseUrl: "http://cc", allowed: () => true, log: { warn: vi.fn() } });
    const interaction = { isButton: () => true, guildId: "guild", channelId: "other", message: { author: { id: "bot" } },
      user: { id: "human" }, customId: `chore:${row.id}:continue`, reply: vi.fn() };
    await surface.interaction(interaction as unknown as Interaction);
    expect(interaction.reply).toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); surface.stopChores();
  });
  it("answers a window request only in the chores forum and guides the window to its thread for an already accepted run (CC-CHORES-FORUM AT-06)", async () => {
    vi.useFakeTimers();
    const run = { ...row, request_key: "discord:123:456" };
    let delivered = false;
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/deliveries")) return new Response(JSON.stringify({ runs: delivered ? [] : [run] }));
      if (String(url).endsWith("/delivery")) { delivered = true; return new Response(JSON.stringify({ ok: true })); }
      return new Response(JSON.stringify({ run }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetcher);
    const send = vi.fn(async (_options: unknown) => ({ id: "notice" }));
    const channel = { id: "channel", type: ChannelType.GuildText, name: "雑務窓口", send, messages: { fetch: vi.fn() } };
    const guild = prepareGuild({ id: "123", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    // v5 前に窓口で受け付けた run。受付時に覚えた投稿元はそのまま残っている。
    const config = memoryConfig();
    config.set("chores_discord_source:discord:123:456", JSON.stringify({ channelId: "channel", messageId: "456", forum: false }));
    const surface = await startChoresDiscord({ guild, config, baseUrl: "http://cc", allowed: () => true, log: { warn: vi.fn() } });
    try {
      await vi.advanceTimersByTimeAsync(9000);
      expect(delivered).toBe(true);
      // 窓口には結果カードを出さず、依頼者への案内を 1 回だけ返信する。
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("<#work-thread>"),
        reply: { messageReference: "456", failIfNotExists: false }, allowedMentions: { parse: [], repliedUser: true } }));
      expect(send.mock.calls[0]![0]).not.toHaveProperty("components");
    } finally { surface.stopChores(); }
  });

  it("builds the accept reply as forum guidance", () => {
    expect(acceptReplyText(row, { fromForum: false, threadId: "t1" })).toContain("<#t1>");
    expect(acceptReplyText(row, { fromForum: true, threadId: "t1" })).toContain("このスレッド");
    expect(acceptReplyText(row, { fromForum: false, threadId: null })).toContain("照合待ち");
  });


});
