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
      parentId: "p", baseUrl: "http://cc", log: { warn: vi.fn() } });
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
  it("moves an existing chores window out of its category (2026-10-06 neco 指示)", async () => {
    const setParent = vi.fn(async () => undefined);
    const channel = { id: "channel", type: ChannelType.GuildText, name: "雑務窓口", parentId: "meta-category", setParent };
    const guild = prepareGuild({ id: "guild", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const surface = await startChoresDiscord({ guild, config: memoryConfig(), parentId: "meta-category", baseUrl: "http://cc", log: { warn: vi.fn() } });
    try {
      expect(setParent).toHaveBeenCalledWith(null, expect.anything());
    } finally { surface.stopChores(); }
  });

  it("ignores bots, denies unauthorized callers and accepts a human in the dedicated channel", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(JSON.stringify({ run: row }), { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    const channel = { id: "channel", type: ChannelType.GuildText, name: "雑務" };
    const guild = prepareGuild({ id: "guild", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const config = memoryConfig();
    const surface = await startChoresDiscord({ guild, config, parentId: "parent", baseUrl: "http://cc", allowed: id => id === "human", log: { warn: vi.fn() } });
    const message = { guildId: "guild", channelId: "channel", id: "message", author: { id: "human", bot: false }, webhookId: null, channel: { isThread: () => false }, content: "[codex] 依頼", reply: vi.fn() };
    expect(surface.handlesMessage(message as unknown as Message)).toBe(true);
    expect(surface.handlesMessage({ ...message, guildId: "other" } as unknown as Message)).toBe(false);
    await surface.message({ ...message, author: { id: "bot", bot: true } } as unknown as Message);
    await surface.message({ ...message, author: { id: "other", bot: false } } as unknown as Message);
    expect(fetcher).not.toHaveBeenCalled();
    await surface.message(message as unknown as Message);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toMatchObject({ provider: "codex", prompt: "依頼", request_key: "discord:guild:message" });
    surface.stopChores();
  });
  it("rejects copied buttons outside the dedicated channel", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const channel = { id: "channel", type: ChannelType.GuildText };
    const guild = prepareGuild({ id: "guild", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const surface = await startChoresDiscord({ guild, config: memoryConfig(),
      parentId: "p", baseUrl: "http://cc", allowed: () => true, log: { warn: vi.fn() } });
    const interaction = { isButton: () => true, guildId: "guild", channelId: "other", message: { author: { id: "bot" } },
      user: { id: "human" }, customId: `chore:${row.id}:continue`, reply: vi.fn() };
    await surface.interaction(interaction as unknown as Interaction);
    expect(interaction.reply).toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); surface.stopChores();
  });
  it("answers a window request only in the chores forum and guides the window to its thread (CC-CHORES-FORUM AT-06)", async () => {
    vi.useFakeTimers();
    const run = { ...row, request_key: "discord:123:456" };
    let delivered = false;
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/deliveries")) return new Response(JSON.stringify({ runs: delivered ? [] : [run] }));
      if (String(url).endsWith("/delivery")) { delivered = true; return new Response(JSON.stringify({ ok: true })); }
      return new Response(JSON.stringify({ run }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetcher);
    const send = vi.fn(async () => ({ id: "notice" }));
    const channel = { id: "channel", type: ChannelType.GuildText, name: "雑務窓口", send, messages: { fetch: vi.fn() } };
    const guild = prepareGuild({ id: "123", channels: { cache: new Map([["channel", channel]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const surface = await startChoresDiscord({ guild, config: memoryConfig(), parentId: "p", baseUrl: "http://cc", allowed: () => true, log: { warn: vi.fn() } });
    const message = { guildId: "123", channelId: "channel", id: "456", author: { id: "human", bot: false }, webhookId: null,
      channel: { isThread: () => false }, content: "依頼", reply: vi.fn() };
    try {
      await surface.message(message as unknown as Message);
      expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("<#work-thread>") }));
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

  it("accepts a forum starter with the same permission and request identity while ignoring discussion and bot mirrors", async () => {
    vi.useFakeTimers();
    const keys: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(options?.body as string) as { request_key: string };
      keys.push(body.request_key);
      return new Response(JSON.stringify({ run: { ...row, request_key: body.request_key } }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetcher);
    const guild = prepareGuild({ id: "guild", channels: { cache: new Map([["channel", { id: "channel", type: ChannelType.GuildText }]]) }, client: { user: { id: "bot" } } } as unknown as Guild);
    const surface = await startChoresDiscord({ guild, config: memoryConfig(), parentId: "p", baseUrl: "http://cc", allowed: id => id === "human", log: { warn: vi.fn() } });
    const message = { guildId: "guild", channelId: "work-thread", id: "work-thread", channel: { isThread: () => true, parentId: "forum" },
      author: { id: "human", bot: false }, webhookId: null, content: "[codex] フォーラムの依頼", reply: vi.fn() } as unknown as Message;
    const target = await guild.channels.fetch("work-thread");
    if (!target?.isThread()) throw new Error("Fixture thread unavailable");
    vi.mocked(target.fetchStarterMessage).mockResolvedValue(message as Message<true>);
    try {
      expect(surface.handlesMessage(message)).toBe(true);
      await surface.message({ ...message, id: "discussion" } as Message);
      await surface.message({ ...message, author: { id: "bot", bot: true } } as unknown as Message);
      await surface.message({ ...message, webhookId: "webhook" } as Message);
      expect(fetcher).not.toHaveBeenCalled();
      await surface.message(message);
      await surface.message(message); // Both gateway paths reuse the original identity; the API is idempotent.
      expect(new Set(keys)).toEqual(new Set(["discord:guild:work-thread"]));
      expect(target.send).toHaveBeenCalledTimes(1);
      expect(message.reply).toHaveBeenCalledTimes(1);
    } finally { surface.stopChores(); }
  });
});
