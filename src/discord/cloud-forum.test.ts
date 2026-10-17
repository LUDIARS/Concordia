import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild, type Message } from "discord.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { ObservationStore } from "../cloud-observation/store.js";
import { cloudForum } from "./cloud-forum.js";
import { startCloudForum } from "./cloud-forum-runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cc-cloud-forum-"));
  const store = new ObservationStore(root);
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const values = new Map<string, string>();
  const config: DiscordConfigRepo = {
    get: key => values.get(key) ?? null, set: (key, value) => { values.set(key, value); },
    delete: key => { values.delete(key); }, all: () => Object.fromEntries(values),
    compareAndSwap(key, expected, value) {
      if ((values.get(key) ?? null) !== expected) return false;
      if (value === null) values.delete(key); else values.set(key, value); return true;
    },
  };
  const starter = { content: "", edit: vi.fn(async (card: { content: string }) => { starter.content = card.content; }) };
  const thread = { id: "thread", parentId: "forum", isThread: () => true,
    send: vi.fn(async (_card: unknown) => ({ id: "message" })), fetchStarterMessage: async () => starter };
  const forum = { id: "forum", type: ChannelType.GuildForum, threads: { create: vi.fn(async () => thread) } };
  const guild = { channels: { fetch: vi.fn(async (id: string) => id === "forum" ? forum : thread) } } as unknown as Guild;
  return { root, store, config, thread, forum, guild };
}
describe("cloud forum delivery", () => {
  it("reuses one thread, sends a preview once, and authorizes answers by thread and question", async () => {
    const f = await fixture();
    f.store.savePreview("tokyo", "run", "image", Buffer.from([255,216,0,255,217]));
    f.store.receive("tokyo", "run", { id: "e", sequence: 1, kind: "preview", previewId: "image", message: "Walls" }, 1000);
    const bridge = cloudForum({ ...f, forumId: "forum", allowed: id => id === "123", now: () => 2000, stopped: () => false });
    await bridge.refresh(); await bridge.refresh();
    expect(f.forum.threads.create).toHaveBeenCalledTimes(1);
    expect(f.thread.send).toHaveBeenCalledTimes(1);
    expect(f.thread.send.mock.calls[0]?.[0]).toMatchObject({ allowedMentions: { parse: [] }, files: [{ name: "preview.jpg" }] });
    f.store.receive("tokyo", "run", { id: "q", sequence: 2, kind: "question", questionId: "height", message: "How tall?" }, 2000);
    const message = { channel: f.thread, channelId: "thread", author: { id: "123", bot: false }, content: "/回答 height 10 floors", reply: vi.fn(async () => {}) } as unknown as Message;
    await bridge.answer(message);
    expect(f.store.get("tokyo", "run")?.state.question?.answer?.text).toBe("10 floors");
    expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [], repliedUser: false } }));
  });
  it("does not recreate a thread or resend a post after an ambiguous failure", async () => {
    const f = await fixture();
    f.store.receive("tokyo", "run", { id: "e", sequence: 1, kind: "progress", message: "Walls" }, 1000);
    f.thread.send.mockRejectedValueOnce(new Error("response lost"));
    const bridge = cloudForum({ ...f, forumId: "forum", allowed: () => true, now: () => 2000, stopped: () => false });
    await expect(bridge.refresh()).rejects.toThrow("delivery_incomplete");
    await bridge.refresh();
    expect(f.forum.threads.create).toHaveBeenCalledTimes(1);
    expect(f.thread.send).toHaveBeenCalledTimes(1);
  });
  it("accepts a reply only to a delivered pending question, including after bridge reconstruction", async () => {
    const f = await fixture();
    f.store.receive("tokyo", "run", { id: "q", sequence: 1, kind: "question", questionId: "height", message: "How tall?" }, 1000);
    const options = { ...f, forumId: "forum", allowed: (id: string) => id === "123", now: () => 2000, stopped: () => false };
    await cloudForum(options).refresh();
    const bridge = cloudForum(options);
    const reply = { channel: f.thread, channelId: "thread", author: { id: "123", bot: false },
      reference: { messageId: "message", channelId: "thread" }, content: "10 floors", reply: vi.fn(async () => {}) } as unknown as Message;
    await bridge.answer({ ...reply, reference: { messageId: "other", channelId: "thread" } } as Message);
    await bridge.answer({ ...reply, reference: { messageId: "message", channelId: "other" } } as Message);
    expect(f.store.get("tokyo", "run")?.state.phase).toBe("waiting_answer");
    await expect(bridge.answer({ ...reply, author: { id: "999", bot: false } } as Message)).rejects.toThrow("forbidden");
    await bridge.answer(reply);
    expect(f.store.get("tokyo", "run")?.state.question?.answer?.text).toBe("10 floors");
    f.store.receive("tokyo", "run", { id: "q2", sequence: 2, kind: "question", questionId: "color", message: "Color?" }, 2000);
    await expect(bridge.answer(reply)).rejects.toThrow("question_not_pending");
    expect(f.store.get("tokyo", "run")?.state.question?.id).toBe("color");
    expect(f.store.get("tokyo", "run")?.state.question?.answer).toBeUndefined();
  });
  it("does not accept ordinary chat or unauthorized answers as instructions", async () => {
    const f = await fixture();
    f.store.receive("tokyo", "run", { id: "q", sequence: 1, kind: "question", questionId: "height", message: "How tall?" }, 1000);
    const bridge = cloudForum({ ...f, forumId: "forum", allowed: () => false, now: () => 2000, stopped: () => false });
    await bridge.refresh();
    const message = { channel: f.thread, channelId: "thread", author: { id: "123", bot: false }, content: "Looks good" } as unknown as Message;
    await bridge.answer(message);
    await expect(bridge.answer({ ...message, content: "/回答 height 10 floors" } as Message)).rejects.toThrow("forbidden");
    expect(f.store.get("tokyo", "run")?.state.phase).toBe("waiting_answer");
  });
  it("drains a pending Discord request before stopping the observation connection", async () => {
    const f = await fixture();
    f.store.receive("tokyo", "run", { id: "e", sequence: 1, kind: "heartbeat" }, 1000);
    let release!: () => void;
    const pending = new Promise<null>(resolve => { release = () => resolve(null); });
    const guild = { channels: { fetch: () => pending } } as unknown as Guild;
    const runtime = startCloudForum({ root: f.root, guild, config: f.config, forumId: "forum", allowed: () => true, warn: () => {} });
    cleanups.push(async () => { release(); await runtime.stop(); });
    let stopped = false;
    const closing = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await closing; await runtime.stop(); expect(stopped).toBe(true);
  });
});
