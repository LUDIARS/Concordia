import { ChannelType, type Guild, type Message } from "discord.js";
import { describe, expect, it } from "vitest";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { CONTROL_CHANNEL_CONFIG_KEY, CONTROL_CHANNEL_NAME, createControlChannelDiscord } from "./control-channel.js";

function fakeGuild() {
  const sent: unknown[] = [];
  const created: unknown[] = [];
  const channel = {
    id: "ch1", type: ChannelType.GuildText, name: CONTROL_CHANNEL_NAME, parentId: "cat", topic: "old",
    setParent: async () => { channel.parentId = null as unknown as string; },
    setTopic: async (topic: string) => { channel.topic = topic; },
    send: async (options: unknown) => { sent.push(options); },
  };
  const cache = new Map<string, unknown>();
  const guild = {
    channels: {
      cache: Object.assign(cache, { find: undefined }),
      create: async (options: unknown) => { created.push(options); cache.set(channel.id, channel); return channel; },
    },
  } as unknown as Guild;
  return { guild, channel, sent, created, cache };
}

function config(): DiscordConfigRepo {
  const values = new Map<string, string>();
  return { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v); } } as unknown as DiscordConfigRepo;
}

function message(patch: Record<string, unknown> = {}) {
  const replies: unknown[] = [];
  const msg = {
    channelId: "ch1", content: "状況は？", webhookId: null,
    author: { id: "u1", bot: false, username: "neco" }, member: { displayName: "ねこ" },
    reply: async (options: unknown) => { replies.push(options); },
    ...patch,
  } as unknown as Message;
  return { msg, replies };
}

describe("control channel Discord surface", () => {
  it("creates the channel outside categories, then routes allowed posts to the control port", async () => {
    const g = fakeGuild();
    const cfg = config();
    const posts: unknown[] = [];
    const surface = createControlChannelDiscord({
      guild: g.guild, config: cfg, allowed: (userId) => userId === "u1",
      port: { handleChannelPost: async (post) => { posts.push(post); return "答え"; } },
      log: { warn: () => {} },
    });
    await surface.ensure();
    expect(g.created).toHaveLength(1);
    expect(g.channel.parentId).toBeNull();
    expect(cfg.get(CONTROL_CHANNEL_CONFIG_KEY)).toBe("ch1");

    const { msg, replies } = message();
    expect(surface.handlesMessage(msg)).toBe(true);
    await surface.message(msg);
    expect(posts).toEqual([{ actorLabel: "ねこ", allowed: true, content: "状況は？" }]);
    expect(replies).toEqual([{ content: "答え", allowedMentions: { parse: [] } }]);

    await surface.post("通知");
    expect(g.sent).toEqual([{ content: "通知", allowedMentions: { parse: [] } }]);
  });

  it("ignores bots, webhooks, other channels and stopped surfaces", async () => {
    const g = fakeGuild();
    const cfg = config();
    cfg.set(CONTROL_CHANNEL_CONFIG_KEY, "ch1");
    const surface = createControlChannelDiscord({
      guild: g.guild, config: cfg, allowed: () => false,
      port: { handleChannelPost: async () => "x" }, log: { warn: () => {} },
    });
    expect(surface.handlesMessage(message({ author: { id: "b", bot: true, username: "bot" } }).msg)).toBe(false);
    expect(surface.handlesMessage(message({ webhookId: "w" }).msg)).toBe(false);
    expect(surface.handlesMessage(message({ channelId: "other" }).msg)).toBe(false);
    surface.stop();
    expect(surface.handlesMessage(message().msg)).toBe(false);
  });
});
