/**
 * SPEC-FED-SITE-FORUM-PARITY: 拠点のセッションを本社と拠点で同じ会話として見せ、 通常セッションと同じ操作感にする。
 */
import { describe, expect, it, vi } from "vitest";
import { createRemoteSessionSite, type RemoteEgressRequest } from "./remote-session-site.js";
import { buildRemoteSpawnPayload } from "./remote-session-payload.js";
import { createRemoteThreadRegistry } from "./remote-thread-registry.js";

const GUILD = "111111111111111111";
const THREAD = "222222222222222222";
const USER = "333333333333333333";
const MESSAGE = "444444444444444444";

function memoryStore() {
  const values = new Map<string, string>();
  return { get: (key: string) => values.get(key) ?? null, set: (key: string, value: string) => { values.set(key, value); } };
}

function setup(over: { answer?: { ok: true } | { ok: false; error: string } } = {}) {
  const registry = createRemoteThreadRegistry(memoryStore(), "k");
  const inject = vi.fn();
  const echo = vi.fn();
  const answerQuestion = vi.fn(async () => over.answer ?? { ok: true as const });
  const egress: RemoteEgressRequest[] = [];
  const site = createRemoteSessionSite({
    registry,
    buildPrompt: (title, body) => `${title}|${body}`,
    spawn: async () => ({ ok: true }),
    findSessionByChannel: () => "sess-1",
    channelOfSession: (sessionId) => (sessionId === "sess-1" ? THREAD : sessionId === "local" ? "999999999999999999" : null),
    inject,
    requestEgress: async (input) => { egress.push(input); return { ok: true }; },
    identityOf: () => ({ username: "Opus 5.5 · opus-5-5", avatarUrl: "https://example.com/a.png" }),
    siteLabel: () => "melpot",
    answerQuestion,
    echoToSiteSurface: echo,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { site, registry, inject, echo, answerQuestion, egress };
}

async function spawned() {
  const h = setup();
  await h.site.handleEvent(buildRemoteSpawnPayload({ guildId: GUILD, channelId: THREAD, authorId: USER, title: "t", body: "b", runtimeRules: [], ts: 1 }));
  h.egress.length = 0;
  return h;
}

const reply = (extra: Record<string, unknown> = {}) => ({
  type: "ingress", guild_id: GUILD, channel_id: THREAD, message_id: MESSAGE, author_id: USER, author_label: "neco", text: "続けて", ts: 1, ...extra,
});

describe("site relay looks like a normal session at HQ", () => {
  it("sends assistant messages with the session's webhook name and icon", async () => {
    const h = await spawned();
    await h.site.relaySessionMessage({ sessionId: "sess-1", authorType: "assistant", content: "やりました" });
    expect(h.egress).toEqual([{ guildId: GUILD, channelId: THREAD, text: "やりました", username: "Opus 5.5 · opus-5-5", avatarUrl: "https://example.com/a.png" }]);
  });

  it("relays a question as a card that asks HQ to mention the requester", async () => {
    const h = await spawned();
    const question = { question_id: 5, prompt: "どれ？", options: [{ label: "A" }] };
    await h.site.relayQuestion({ sessionId: "sess-1", question });
    await h.site.relayQuestion({ sessionId: "unknown", question });
    expect(h.egress).toEqual([expect.objectContaining({ channelId: THREAD, question, mentionRequester: true, username: "Opus 5.5 · opus-5-5" })]);
  });

  it("shows people who write in the site's Discord at HQ, but not echoes of HQ replies", async () => {
    const h = await spawned();
    await h.site.handleEvent(reply());
    await h.site.relaySessionMessage({ sessionId: "sess-1", authorType: "user", content: "続けて", authorPlatform: "discord", authorLabel: "neco", injectSource: `discord:${USER}:${MESSAGE}` });
    await h.site.relaySessionMessage({ sessionId: "sess-1", authorType: "user", content: "拠点から", authorPlatform: "discord", authorLabel: "kuzu", injectSource: `discord:${USER}:555555555555555555` });
    await h.site.relaySessionMessage({ sessionId: "sess-1", authorType: "user", content: "端末入力", authorPlatform: null, authorLabel: "user", injectSource: null });
    expect(h.egress).toEqual([
      { guildId: GUILD, channelId: THREAD, text: "✅", ackMessageId: MESSAGE },
      { guildId: GUILD, channelId: THREAD, text: "拠点から", username: "kuzu (melpot)" },
    ]);
  });
});

describe("HQ replies get ✅ once the site session takes them", () => {
  const hqEcho = { sessionId: "sess-1", authorType: "user", content: "続けて", authorPlatform: "discord", authorLabel: "neco", injectSource: `discord:${USER}:${MESSAGE}` };

  it("does not ack on arrival, only when the session reads the reply, and only once", async () => {
    const h = await spawned();
    await h.site.handleEvent(reply());
    expect(h.egress).toEqual([]);
    await h.site.relaySessionMessage(hqEcho);
    await h.site.relaySessionMessage(hqEcho);
    expect(h.egress).toEqual([{ guildId: GUILD, channelId: THREAD, text: "✅", ackMessageId: MESSAGE }]);
  });

  it("does not ack question answers, which are not injected as text", async () => {
    const h = await spawned();
    await h.site.handleEvent(reply({ answer: { question_id: 5, option_indexes: [0] } }));
    await h.site.relaySessionMessage(hqEcho);
    expect(h.egress.filter((e) => e.ackMessageId)).toEqual([]);
  });
});

describe("HQ replies and answers reach the site session", () => {
  it("injects an HQ reply and also shows it on the site's own forum post", async () => {
    const h = await spawned();
    await h.site.handleEvent(reply());
    expect(h.inject).toHaveBeenCalledWith({ sessionId: "sess-1", text: "続けて", source: `discord:${USER}:${MESSAGE}` });
    expect(h.echo).toHaveBeenCalledWith({ sessionId: "sess-1", authorLabel: "neco", text: "続けて" });
  });

  it("answers the site's question from an HQ card press instead of injecting text", async () => {
    const h = await spawned();
    await h.site.handleEvent(reply({ text: "A", answer: { question_id: 5, option_indexes: [0] } }));
    expect(h.answerQuestion).toHaveBeenCalledWith({ sessionId: "sess-1", questionId: 5, optionIndexes: [0] });
    expect(h.inject).not.toHaveBeenCalled();
    expect(h.egress).toEqual([]);
  });

  it("tells HQ when the site could not take the answer", async () => {
    const h = setup({ answer: { ok: false, error: "already_answered" } });
    await h.site.handleEvent(buildRemoteSpawnPayload({ guildId: GUILD, channelId: THREAD, authorId: USER, title: "t", body: "b", runtimeRules: [], ts: 1 }));
    h.egress.length = 0;
    await h.site.handleEvent(reply({ answer: { question_id: 5, option_indexes: [0] } }));
    expect(h.egress[0]?.text).toContain("already_answered");
  });
});

describe("mentions stay on the launching side", () => {
  it("knows which sessions HQ launched", async () => {
    const h = await spawned();
    expect(h.site.isHqLaunched("sess-1")).toBe(true);
    expect(h.site.isHqLaunched("local")).toBe(false);
    expect(h.site.isHqLaunched("missing")).toBe(false);
  });
});
