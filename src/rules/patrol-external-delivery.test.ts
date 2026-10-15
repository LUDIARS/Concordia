import { describe, expect, it, vi } from "vitest";
import { PATROL_WEBHOOK_NAME, makeExternalChannelPoster } from "./patrol-external-delivery.js";
import { deliverExternal, externalChannelOf } from "./patrol-runtime.js";
import type { ChatMessageRow } from "../db/chat-repo.js";

const CHANNEL = "1546109590930853962";
const GLAB = "1352438523155841126";

interface Call { url: string; method: string; body: any; auth: string | null }

function fakeDiscord(opts: { guildId?: string; webhookCreate?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.authorization ?? null });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.endsWith(`/channels/${CHANNEL}`)) return json(200, { id: CHANNEL, guild_id: opts.guildId ?? GLAB });
    if (url.endsWith(`/channels/${CHANNEL}/webhooks`) && method === "GET") return json(200, []);
    if (url.endsWith(`/channels/${CHANNEL}/webhooks`) && method === "POST") {
      return opts.webhookCreate ? json(opts.webhookCreate, { message: "Missing Permissions" }) : json(200, { id: "wh1", token: "tok1" });
    }
    if (url.includes("/webhooks/wh1/tok1?wait=true")) return json(200, { id: "m-webhook" });
    if (url.endsWith(`/channels/${CHANNEL}/messages`)) return json(200, { id: "m-bot" });
    return json(404, {});
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("external channel delivery", () => {
  it("posts to a subsidiary guild channel through a patrol webhook under the persona name", async () => {
    const d = fakeDiscord();
    const post = makeExternalChannelPoster({ botToken: () => "bot-token", allowedGuildIds: () => ["hq", GLAB], fetchImpl: d.fetchImpl });
    expect(await post({ channelId: CHANNEL, content: "本文", username: "噂坂 聞 (巡回)" })).toEqual({ messageId: "m-webhook" });
    expect(d.calls.find((c) => c.method === "POST" && c.url.endsWith("/webhooks"))?.body).toEqual({ name: PATROL_WEBHOOK_NAME });
    const exec = d.calls.find((c) => c.url.includes("?wait=true"))!;
    expect(exec.body).toEqual({ content: "本文", username: "噂坂 聞 (巡回)", allowed_mentions: { parse: [] } });
    expect(exec.auth).toBeNull();
    // 2 回目は作った webhook を使い回す
    await post({ channelId: CHANNEL, content: "次", username: null });
    expect(d.calls.filter((c) => c.method === "POST" && c.url.endsWith("/webhooks"))).toHaveLength(1);
  });

  it("refuses channels outside the HQ and enabled subsidiary guilds", async () => {
    const d = fakeDiscord({ guildId: "999999999999999999" });
    const post = makeExternalChannelPoster({ botToken: () => "t", allowedGuildIds: () => [GLAB], fetchImpl: d.fetchImpl });
    await expect(post({ channelId: CHANNEL, content: "x", username: null })).rejects.toThrow(/not in the rule owner's guild/);
    expect(d.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("falls back to a bot message with the name in bold when webhooks are not permitted", async () => {
    const d = fakeDiscord({ webhookCreate: 403 });
    const post = makeExternalChannelPoster({ botToken: () => "t", allowedGuildIds: () => [GLAB], fetchImpl: d.fetchImpl });
    expect(await post({ channelId: CHANNEL, content: "本文", username: "拾井 種 (巡回)" })).toEqual({ messageId: "m-bot" });
    const msg = d.calls.find((c) => c.url.endsWith("/messages"))!;
    expect(msg.body).toEqual({ content: "**拾井 種 (巡回)**\n本文", allowed_mentions: { parse: [] } });
    expect(msg.auth).toBe("Bot t");
  });

  it("does nothing without a bot token", async () => {
    const d = fakeDiscord();
    const post = makeExternalChannelPoster({ botToken: () => null, allowedGuildIds: () => [GLAB], fetchImpl: d.fetchImpl });
    await expect(post({ channelId: CHANNEL, content: "x", username: null })).rejects.toThrow(/token/);
    expect(d.calls).toHaveLength(0);
  });
});

describe("patrol runtime external routing", () => {
  const row = (metadata: Record<string, unknown>): ChatMessageRow => ({
    id: 7, channel: "chitchat", session_id: null, author_label: "巡回チャット", ts: 1, text: "本文",
    in_reply_to: null, is_actionable: 0, metadata: JSON.stringify(metadata),
  } as unknown as ChatMessageRow);

  it("reads the channel only from a valid patrol_discord_channel_id", () => {
    expect(externalChannelOf(JSON.stringify({ patrol_discord_channel_id: CHANNEL }))).toBe(CHANNEL);
    expect(externalChannelOf(JSON.stringify({ patrol_discord_channel_id: "abc" }))).toBeNull();
    expect(externalChannelOf(null)).toBeNull();
  });

  it("limits delivery to the owner's guild", async () => {
    const poster = vi.fn(async () => ({ messageId: "m2" }));
    const put = vi.fn();
    const ownerGuild = (sub: string | null) => (sub === "sub-glab" ? GLAB : sub === null ? "hq-guild" : null);
    expect(await deliverExternal(poster, { put }, row({ patrol_subsidiary_id: "sub-glab" }), CHANNEL, undefined, ownerGuild)).toBe(true);
    expect(poster).toHaveBeenLastCalledWith(expect.objectContaining({ allowedGuildIds: [GLAB] }));
    expect(await deliverExternal(poster, { put }, row({}), CHANNEL, undefined, ownerGuild)).toBe(true);
    expect(poster).toHaveBeenLastCalledWith(expect.objectContaining({ allowedGuildIds: ["hq-guild"] }));
    const warn = vi.fn();
    expect(await deliverExternal(poster, { put }, row({ patrol_subsidiary_id: "gone" }), CHANNEL, { warn }, ownerGuild)).toBe(false);
    expect(poster).toHaveBeenCalledTimes(2);
  });

  it("uses the per-post guild allowlist over the global one", async () => {
    const d = fakeDiscord();
    const post = makeExternalChannelPoster({ botToken: () => "t", allowedGuildIds: () => [GLAB], fetchImpl: d.fetchImpl });
    await expect(post({ channelId: CHANNEL, content: "x", username: null, allowedGuildIds: ["other"] })).rejects.toThrow(/owner's guild/);
  });

  it("records the Discord message only after a successful post, never retrying", async () => {
    const put = vi.fn();
    const poster = vi.fn(async () => ({ messageId: "m1" }));
    expect(await deliverExternal(poster, { put }, row({ webhook_username: "旬田 摘 (巡回)" }), CHANNEL)).toBe(true);
    expect(poster).toHaveBeenCalledWith({ channelId: CHANNEL, content: "本文", username: "旬田 摘 (巡回)" });
    expect(put).toHaveBeenCalledWith("m1", 7);
    const failing = vi.fn(async () => { throw new Error("403"); });
    const warn = vi.fn();
    expect(await deliverExternal(failing, { put }, row({}), CHANNEL, { warn })).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/failed/);
    expect(await deliverExternal(null, { put }, row({}), CHANNEL, { warn })).toBe(false);
  });
});
