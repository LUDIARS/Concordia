import { describe, it, expect, vi } from "vitest";
import { createRemoteSessionSite, splitForRelay, REMOTE_RELAY_CHUNK } from "./remote-session-site.js";
import { buildRemoteSpawnPayload, parseSiteEventPayload, REMOTE_SPAWN_MAX_BODY } from "./remote-session-payload.js";
import { createRemoteThreadRegistry, REMOTE_THREAD_LIMIT } from "./remote-thread-registry.js";
import { readSourceChannel } from "./remote-session-wiring.js";

const GUILD = "111111111111111111";
const THREAD = "222222222222222222";
const USER = "333333333333333333";

function memoryStore() {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
}

function setup(over: { spawnOk?: boolean; sessionId?: string | null } = {}) {
  const registry = createRemoteThreadRegistry(memoryStore(), "k");
  const spawn = vi.fn(async () => (over.spawnOk === false ? { ok: false, error: "x" } : { ok: true }));
  const inject = vi.fn();
  const egress: { channelId: string; text: string }[] = [];
  const site = createRemoteSessionSite({
    registry,
    buildPrompt: (title, body, rules) => `${title}|${body}|${rules.join(",")}`,
    spawn,
    findSessionByChannel: () => (over.sessionId === undefined ? "sess-1" : over.sessionId),
    channelOfSession: (sessionId) => (sessionId === "sess-1" ? THREAD : null),
    inject,
    requestEgress: async (input) => { egress.push(input); return { ok: true }; },
    log: { info: () => undefined, warn: () => undefined },
  });
  return { site, registry, spawn, inject, egress };
}

const spawnPayload = () => buildRemoteSpawnPayload({
  guildId: GUILD, channelId: THREAD, authorId: USER, title: "[Cc] 作業", body: "本文", runtimeRules: ["rule-a"], ts: 100,
});

describe("remote session payload", () => {
  it("builds and parses spawn / ingress, rejecting unknown or broken payloads", () => {
    const payload = buildRemoteSpawnPayload({ guildId: GUILD, channelId: THREAD, authorId: null, title: "t", body: "x".repeat(REMOTE_SPAWN_MAX_BODY + 10), runtimeRules: [], ts: 1 });
    expect(payload.body).toHaveLength(REMOTE_SPAWN_MAX_BODY);
    expect(parseSiteEventPayload(payload)).toEqual(payload);
    expect(parseSiteEventPayload({ type: "ingress", guild_id: GUILD, channel_id: THREAD, message_id: "444444444444444444", author_id: USER, author_label: "neco", text: "hi", ts: 1 })?.type).toBe("ingress");
    expect(parseSiteEventPayload({ type: "spawn", guild_id: "bad" })).toBeNull();
    expect(parseSiteEventPayload({ type: "other" })).toBeNull();
    expect(parseSiteEventPayload(null)).toBeNull();
  });
});

describe("remote thread registry", () => {
  it("records once and keeps only the newest entries", () => {
    const registry = createRemoteThreadRegistry(memoryStore(), "k");
    expect(registry.record("1", { guildId: GUILD, siteId: "s", at: 1 })).toBe(true);
    expect(registry.record("1", { guildId: GUILD, siteId: "s", at: 2 })).toBe(false);
    for (let i = 0; i < REMOTE_THREAD_LIMIT + 5; i += 1) registry.record(`c${i}`, { guildId: GUILD, siteId: null, at: 10 + i });
    expect(registry.find("1")).toBeNull();
    expect(registry.find(`c${REMOTE_THREAD_LIMIT + 4}`)?.guildId).toBe(GUILD);
  });
});

describe("remote session site", () => {
  it("spawns once per thread with the forum prompt and reports the result to the thread", async () => {
    const h = setup();
    await h.site.handleEvent(spawnPayload());
    await h.site.handleEvent(spawnPayload()); // at-least-once 再送
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledWith({ guildId: GUILD, channelId: THREAD, authorId: USER, prompt: "[Cc] 作業|本文|rule-a" });
    expect(h.egress).toEqual([{ guildId: GUILD, channelId: THREAD, text: expect.stringContaining("起動しました") }]);
  });

  it("reports a spawn failure to the thread", async () => {
    const h = setup({ spawnOk: false });
    await h.site.handleEvent(spawnPayload());
    expect(h.egress[0]?.text).toContain("失敗");
  });

  it("injects replies as human input, skipping the starter post and unknown threads", async () => {
    const h = setup();
    const reply = (messageId: string, channelId = THREAD) => ({ type: "ingress", guild_id: GUILD, channel_id: channelId, message_id: messageId, author_id: USER, author_label: "neco", text: "続けて", ts: 1 });
    await h.site.handleEvent(reply("444444444444444444")); // 未起動スレッド
    await h.site.handleEvent(spawnPayload());
    await h.site.handleEvent(reply(THREAD)); // forum の最初の投稿
    await h.site.handleEvent(reply("444444444444444444"));
    expect(h.inject).toHaveBeenCalledTimes(1);
    expect(h.inject).toHaveBeenCalledWith({ sessionId: "sess-1", text: "続けて", source: `discord:${USER}:444444444444444444` });
  });

  it("tells the thread when no session is running yet", async () => {
    const h = setup({ sessionId: null });
    await h.site.handleEvent(spawnPayload());
    await h.site.handleEvent({ type: "ingress", guild_id: GUILD, channel_id: THREAD, message_id: "444444444444444444", author_id: USER, author_label: "neco", text: "x", ts: 1 });
    expect(h.inject).not.toHaveBeenCalled();
    expect(h.egress.at(-1)?.text).toContain("準備中");
  });

  it("relays only assistant messages of remote threads, split into chunks", async () => {
    const h = setup();
    await h.site.relaySessionMessage({ sessionId: "sess-1", authorType: "assistant", content: "before spawn" });
    expect(h.egress).toEqual([]);
    await h.site.handleEvent(spawnPayload());
    h.egress.length = 0;
    await h.site.relaySessionMessage({ sessionId: "sess-1", authorType: "user", content: "echo" });
    await h.site.relaySessionMessage({ sessionId: "other", authorType: "assistant", content: "other" });
    await h.site.relaySessionMessage({ sessionId: "sess-1", authorType: "assistant", content: "a".repeat(REMOTE_RELAY_CHUNK + 1) });
    expect(h.egress.map((item) => item.text.length)).toEqual([REMOTE_RELAY_CHUNK, 1]);
    expect(splitForRelay("  ")).toEqual([]);
    expect(readSourceChannel(JSON.stringify({ discord_source_channel_id: THREAD }))).toBe(THREAD);
    expect(readSourceChannel("broken")).toBeNull();
  });
});
