import { describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild, type Message } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { Chore } from "../chores/domain.js";
import { choreCard } from "./chores.js";
import { createChoresForum } from "./chores-forum.js";

const run: Chore = { id: "00000000-0000-4000-8000-000000000001", request_key: "discord:guild:human-message", prompt: "依頼",
  provider: "claude", status: "succeeded", cwd: "work", output: "成果", error: null, spawn_id: null,
  created_at: 1, updated_at: 2, revision: 3, delivered_revision: 0, discord_message_id: null };

function fixture() {
  const values = new Map<string, string>([["chores_forum_id", "forum"]]);
  const config: DiscordConfigRepo = {
    get: key => values.get(key) ?? null, set: (key, value) => { values.set(key, value); },
    delete: key => { values.delete(key); }, all: () => Object.fromEntries(values),
    compareAndSwap(key, expected, value) {
      if ((values.get(key) ?? null) !== expected) return false;
      if (value === null) values.delete(key); else values.set(key, value);
      return true;
    },
  };
  let stopped = false;
  const card = { id: "card", content: choreCard(run).content, author: { id: "bot" }, components: [{ components: [{ customId: `chore:${run.id}:ok` }] }],
    edit: vi.fn(async (options: { content: string }) => { card.content = options.content; return card; }) };
  const thread = { id: "thread", name: `雑務-${run.id.slice(0, 8)}`, guildId: "guild", parentId: "forum", isThread: () => true,
    fetchStarterMessage: vi.fn(async () => card), send: vi.fn(async () => card), messages: { fetch: vi.fn(async () => card) } };
  const forum = { id: "forum", type: ChannelType.GuildForum, name: "雑務課", threads: {
    create: vi.fn(async () => thread), fetchActive: vi.fn(async () => ({ threads: new Map<string, typeof thread>() })),
  } };
  const guild = { id: "guild", client: { user: { id: "bot" } }, channels: {
    cache: new Map([["forum", forum]]), fetch: vi.fn(async () => thread),
  } } as unknown as Guild;
  const create = () => createChoresForum({ guild, config, windowId: "window", card: choreCard, stopped: () => stopped });
  return { config, create, values, card, thread, forum, stop: () => { stopped = true; } };
}

describe("durable chores forum delivery addresses", () => {
  it("moves the chores forum out of its category", async () => {
    const f = fixture();
    const setParent = vi.fn(async () => f.forum);
    Object.assign(f.forum, { parentId: "meta-category", setParent });
    await f.create();
    expect(setParent).toHaveBeenCalledWith(null, expect.anything());
  });
  it("creates one work record for concurrent delivery and adopts it after reconnect", async () => {
    const f = fixture();
    const surface = await f.create();
    await Promise.all([surface.mirror(run), surface.mirror(run)]);
    await (await f.create()).mirror({ ...run, status: "acknowledged", revision: 4 });
    expect(f.forum.threads.create).toHaveBeenCalledTimes(1);
    expect(f.card.edit).toHaveBeenCalledTimes(2);
    expect(surface.canOperate(run.id, "thread", "card")).toBe(true);
    expect(surface.canOperate(run.id, "copied-thread", "card")).toBe(false);
    expect(surface.canOperate(run.id, "thread", "copied-card")).toBe(false);
  });
  it("uses the human's forum thread instead of creating another work thread", async () => {
    const f = fixture();
    f.thread.fetchStarterMessage.mockResolvedValue({ ...f.card, author: { id: "human" } });
    const surface = await f.create();
    surface.rememberSource(run.request_key, { channelId: "thread", id: "thread", channel: { isThread: () => true } } as unknown as Message);
    await surface.mirror(run);
    expect(f.forum.threads.create).not.toHaveBeenCalled();
    expect(f.thread.send).toHaveBeenCalledTimes(1);
    expect((await surface.resultChannel(run))?.id).toBe("thread");
    expect(surface.canOperate(run.id, "window", "card")).toBe(false);
    expect(surface.canOperate(run.id, "thread", "card")).toBe(true);
  });
  it("does not replay an unknown thread creation and can adopt a confirmed original", async () => {
    const f = fixture();
    f.forum.threads.create.mockRejectedValueOnce(new Error("connection lost after create"));
    const surface = await f.create();
    await expect(surface.mirror(run)).rejects.toThrow("connection lost");
    await expect((await f.create()).mirror(run)).rejects.toThrow("結果が不明");
    expect(f.forum.threads.create).toHaveBeenCalledTimes(1);
    f.forum.threads.fetchActive.mockResolvedValueOnce({ threads: new Map([["thread", f.thread]]) });
    await (await f.create()).mirror(run);
    expect(f.forum.threads.create).toHaveBeenCalledTimes(1);
    expect(surface.forumCardId(run.id)).toBe("card");
  });
  it("preserves confirmed external addresses if stop arrives during creation", async () => {
    const f = fixture();
    f.forum.threads.create.mockImplementationOnce(async () => { f.stop(); return f.thread; });
    const surface = await f.create();
    await expect(surface.mirror(run)).rejects.toThrow("停止");
    expect(surface.forumCardId(run.id)).toBe("card");
    expect(f.card.edit).not.toHaveBeenCalled();
    expect(f.forum.threads.create).toHaveBeenCalledTimes(1);
  });
  it("does not replay an unknown card send and adopts a confirmed bot card", async () => {
    const f = fixture(); const surface = await f.create();
    surface.rememberSource(run.request_key, { channelId: "thread", id: "thread", channel: { isThread: () => true } } as unknown as Message);
    f.thread.fetchStarterMessage.mockResolvedValue({ ...f.card, author: { id: "human" } });
    f.thread.send.mockRejectedValueOnce(new Error("send outcome unknown"));
    await expect(surface.mirror(run)).rejects.toThrow("send outcome unknown");
    f.thread.messages.fetch.mockResolvedValueOnce(new Map() as never);
    await expect((await f.create()).mirror(run)).rejects.toThrow("結果が不明");
    expect(f.thread.send).toHaveBeenCalledTimes(1);
    f.thread.messages.fetch.mockResolvedValueOnce(new Map([["card", f.card]]) as never);
    await (await f.create()).mirror(run);
    expect(f.thread.send).toHaveBeenCalledTimes(1);
    expect(surface.forumCardId(run.id)).toBe("card");
  });
  it("adopts the original starter after its fetch failed instead of sending a second card", async () => {
    const f = fixture(); const surface = await f.create();
    f.thread.fetchStarterMessage.mockRejectedValueOnce(new Error("starter fetch failed"));
    await expect(surface.mirror(run)).rejects.toThrow("starter fetch failed");
    await (await f.create()).mirror(run);
    expect(f.forum.threads.create).toHaveBeenCalledTimes(1);
    expect(f.thread.send).not.toHaveBeenCalled();
    expect(surface.forumCardId(run.id)).toBe("card");
  });
  it("holds unknown edits and does not overwrite a newer confirmed revision", async () => {
    const f = fixture(); const surface = await f.create();
    await surface.mirror(run);
    const newer = { ...run, status: "acknowledged" as const, revision: 4 };
    f.card.edit.mockRejectedValueOnce(new Error("edit outcome unknown"));
    await expect(surface.mirror(newer)).rejects.toThrow("edit outcome unknown");
    await expect((await f.create()).mirror(newer)).rejects.toThrow("結果が不明");
    const attempts = f.card.edit.mock.calls.length;
    f.card.content = choreCard(newer).content; // Readback confirms the original operation's result.
    await (await f.create()).mirror(newer);
    await surface.mirror(run);
    expect(f.card.edit).toHaveBeenCalledTimes(attempts);
    expect(f.card.content).toBe(choreCard(newer).content);
  });
  it("rejects a changed acceptance origin and malformed saved addresses", async () => {
    const f = fixture(); const surface = await f.create();
    const message = { channelId: "window", id: "human-message", channel: { isThread: () => false } } as unknown as Message;
    surface.rememberSource(run.request_key, message);
    expect(() => surface.rememberSource(run.request_key, { ...message, channelId: "other" } as Message)).toThrow("一致");
    f.values.set(`chores_forum_run:${run.id}`, JSON.stringify({ threadId: "foreign" }));
    await expect(surface.mirror(run)).rejects.toThrow();
    expect(f.forum.threads.create).not.toHaveBeenCalled();
  });
});
