import { describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild, type Message } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { DeskRequest } from "../desk/desk-request-policy.js";
import type { ControlCard } from "../control-cards/card-domain.js";
import type { CardChange } from "../control-cards/card-sync.js";
import type { ReminderDelivery } from "../control-cards/reminder-runner.js";
import { startDeskDiscord, type DeskDiscordPort } from "./desk.js";
import { acceptedNotice, cardNotice, DESK_CHANNEL_NAME, deskThreadName, stateNotice } from "./desk-notices.js";

function memoryConfig(initial: Record<string, string> = {}): DiscordConfigRepo {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null, set: (key, value) => { values.set(key, value); }, delete: (key) => { values.delete(key); },
    all: () => Object.fromEntries(values),
    compareAndSwap(key, expected, value) {
      if ((values.get(key) ?? null) !== expected) return false;
      if (value === null) values.delete(key); else values.set(key, value);
      return true;
    },
  };
}

function request(patch: Partial<DeskRequest> = {}): DeskRequest {
  return {
    id: "11111111-aaaa", request_key: "discord:1:2", origin: "discord", requester: "human", provider: "claude", body: "依頼の本文",
    state: "accepted", spawn_id: null, session_id: null, launch_deadline_at: null, error: null, discord_thread_id: null,
    created_at: 1, updated_at: 1, revision: 1, ...patch,
  };
}

function harness() {
  const threadSends: Array<{ content: string; allowedMentions: unknown }> = [];
  const thread = { id: "thread-1", guildId: "1", isThread: () => true, send: vi.fn(async (payload: { content: string; allowedMentions: unknown }) => { threadSends.push(payload); return payload; }) };
  const setName = vi.fn(async () => undefined);
  const setParent = vi.fn(async () => undefined);
  const channel = { id: "window", type: ChannelType.GuildText, name: "雑務窓口", topic: "", parentId: "cat", setName, setParent, setTopic: vi.fn(async () => undefined) };
  const guild = {
    id: "1", client: { user: { id: "bot" } },
    channels: { cache: new Map([["window", channel]]), fetch: vi.fn(async (id: string) => (id === "thread-1" ? thread : id === "window" ? channel : null)), create: vi.fn() },
  } as unknown as Guild;
  let stored = request();
  const listeners: { request: ((r: DeskRequest) => void) | null; card: ((c: CardChange) => void) | null; reminder: ReminderDelivery["deliver"] | null } = { request: null, card: null, reminder: null };
  const port: DeskDiscordPort = {
    submit: vi.fn(() => ({ kind: "created" as const, request: stored })),
    attachThread: vi.fn((_id: string, threadId: string) => { stored = { ...stored, discord_thread_id: threadId }; return true; }),
    get: () => stored,
    findBySession: () => stored,
    attachRequestListener: (listener) => { listeners.request = listener; },
    attachCardListener: (listener) => { listeners.card = listener; },
    attachReminder: (deliver) => { listeners.reminder = deliver; },
    sessionLinks: (id) => ({ discord: `https://discord.com/channels/1/${id}`, web: `http://cc/sessions/${id}` }),
    webUrl: (path) => `http://cc${path}`,
  };
  return { guild, channel, thread, threadSends, port, listeners, setStored: (next: DeskRequest) => { stored = next; } };
}

function post(patch: Record<string, unknown> = {}): Message {
  return {
    guildId: "1", channelId: "window", id: "2", author: { id: "human", bot: false }, webhookId: null, content: "[codex] 依頼の本文",
    channel: { isThread: () => false }, reply: vi.fn(), startThread: vi.fn(async () => ({ id: "thread-1" })), ...patch,
  } as unknown as Message;
}

describe("依頼窓口の知らせ", () => {
  it("renders thread name, acceptance, state, and card notices", () => {
    expect(deskThreadName(request())).toBe("依頼 11111111 依頼の本文");
    expect(acceptedNotice(request(), "http://cc/desk")).toContain("http://cc/desk");
    expect(stateNotice(request({ state: "running" }), { discord: "https://d/1", web: "http://cc/s" })).toContain("Discord: https://d/1");
    expect(stateNotice(request({ state: "launch_failed", error: "上限" }), null)).toContain("上限");
    expect(stateNotice(request({ state: "accepted" }), null)).toBeNull();
    expect(cardNotice("opened", { card_kind: "human_action", summary: "打って", link: "http://cc/x", close_reason: null })).toContain("人間のアクション");
  });
});

describe("Discord の依頼窓口 (Cc v5)", () => {
  it("renames the chores window to the desk, keeps its id and takes it out of the category", async () => {
    const h = harness();
    const config = memoryConfig({ chores_channel_id: "window" });
    const surface = await startDeskDiscord({ guild: h.guild, config, port: h.port, allowed: () => true, log: { warn: vi.fn() } });
    expect(h.channel.setName).toHaveBeenCalledWith(DESK_CHANNEL_NAME);
    expect(h.channel.setParent).toHaveBeenCalledWith(null, expect.anything());
    expect(config.get("chores_channel_id")).toBe("window");
    surface.stop();
  });

  it("accepts a post through the same use case as the Web, opens one thread and posts the acceptance once (CC-V5-INV-07)", async () => {
    const h = harness();
    const surface = await startDeskDiscord({ guild: h.guild, config: memoryConfig({ chores_channel_id: "window" }), port: h.port, allowed: (id) => id === "human", log: { warn: vi.fn() } });
    const message = post();
    expect(surface.handlesMessage(message)).toBe(true);
    await surface.message(post({ author: { id: "bot", bot: true } }));
    await surface.message(post({ author: { id: "other", bot: false } }));
    expect(h.port.submit).not.toHaveBeenCalled();
    await surface.message(message);
    await surface.message(message); // 同じ投稿の再処理
    expect(h.port.submit).toHaveBeenCalledWith({ requestKey: "discord:1:2", requester: "human", provider: "codex", body: "依頼の本文" });
    expect(message.startThread).toHaveBeenCalledTimes(1);
    expect(h.threadSends.filter((send) => send.content.includes("受け付けました"))).toHaveLength(1);
    surface.stop();
  });

  it("posts launch, card open/close notices once each and reminders with only the assignee mentioned", async () => {
    const h = harness();
    const surface = await startDeskDiscord({ guild: h.guild, config: memoryConfig({ chores_channel_id: "window" }), port: h.port, allowed: () => true, log: { warn: vi.fn() } });
    await surface.message(post());
    const running = request({ state: "running", session_id: "sess", discord_thread_id: "thread-1" });
    h.setStored(running);
    h.listeners.request!(running);
    h.listeners.request!(running);
    const card = { id: "c1", card_kind: "human_judgment", summary: "承認して", link: null, session_id: "sess", updated_at: 5, closed_at: null, close_reason: null } as unknown as ControlCard;
    h.listeners.card!({ kind: "opened", card });
    h.listeners.card!({ kind: "opened", card });
    await vi.waitFor(() => expect(h.threadSends.map((send) => send.content)).toEqual([
      expect.stringContaining("受け付けました"), expect.stringContaining("起動しました"), expect.stringContaining("承認して"),
    ]));
    const channel = await h.listeners.reminder!({ card, text: "⏰ 催促", mentionUserId: "123456789012345678" });
    expect(channel).toBe("desk-thread:thread-1");
    expect(h.threadSends.at(-1)).toEqual({ content: "<@123456789012345678>\n⏰ 催促", allowedMentions: { parse: [], users: ["123456789012345678"] } });
    surface.stop();
    expect(h.listeners.request).toBeNull();
  });
});
