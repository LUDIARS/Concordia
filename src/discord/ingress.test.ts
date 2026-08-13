import { ChannelType, type Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessage, resolveMetaKind, type IngressDeps } from "./ingress.js";
import { clearInjectAcks, takeInjectAck } from "./inject-ack.js";

describe("discord ingress inject acceptance reactions", () => {
  beforeEach(() => {
    clearInjectAcks();
  });

  afterEach(() => {
    clearInjectAcks();
    vi.unstubAllGlobals();
  });

  it("reacts immediately when a codex session accepts a Discord inject", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("codex-cli");
    const msg = makeMessage();

    await handleMessage(deps, msg);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(msg.react).toHaveBeenCalledWith("✅");
    expect(takeInjectAck("s1")).toBeNull();
  });

  it("keeps non-codex inject reactions deferred", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    const msg = makeMessage();

    await handleMessage(deps, msg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(msg.react).not.toHaveBeenCalled();
    expect(takeInjectAck("s1")).toMatchObject({ channelId: "chan1", messageId: "msg1" });
  });

  it("falls back to deferred ack when the codex acceptance reaction fails", async () => {
    stubSuccessfulFetch();
    const deps = makeDeps("codex-cli");
    const react = vi.fn(async () => {
      throw new Error("missing permissions");
    });
    const msg = makeMessage({ react });

    await handleMessage(deps, msg);

    expect(react).toHaveBeenCalledWith("✅");
    expect(takeInjectAck("s1")).toMatchObject({ channelId: "chan1", messageId: "msg1" });
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("accepted react failed"));
  });
});

describe("discord ingress chat routing", () => {
  it("recognizes the configured boyaki meta channel", () => {
    const configRepo = {
      all: vi.fn(() => ({ boyaki_channel_id: "boyaki-1" })),
    } as unknown as IngressDeps["configRepo"];
    expect(resolveMetaKind(configRepo, "boyaki-1")).toBe("boyaki");
  });

  it("rejects the control trigger in subsidiary guilds", async () => {
    const deps = { ...makeDeps("codex-cli"), subsidiary: true };
    const msg = makeMessage({ content: "control" });
    await handleMessage(deps, msg);
    expect((msg.channel as unknown as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("利用できません") }));
  });

  it("keeps the control trigger available in the head-office guild", async () => {
    const msg = makeMessage({ content: "control" });
    await handleMessage(makeDeps("codex-cli"), msg);
    expect((msg.channel as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledOnce();
  });

  it("injects replies into the existing session", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    const msg = makeMessage({ reference: { messageId: "parent" } });
    await handleMessage(deps, msg);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://concordia.test/v1/sessions/s1/inject");
    expect(deps.log.info).toHaveBeenCalledWith(expect.stringContaining("inject ok"));
  });

  it("marks an authorized spoken session-end request after a successful inject", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    deps.isSessionEndUserAllowed = () => true;

    await handleMessage(deps, makeMessage({ content: "セッションを終了してください" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(deps.sessionsRepo.mergeMetadata).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ session_end_requested_at: expect.any(Number) }),
    );
  });

  it("fails closed for a spoken session-end request when authorization is not wired", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    const msg = makeMessage({ content: "session-end してください" });

    await handleMessage(deps, msg);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.sessionsRepo.mergeMetadata).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("終了権限") }));
  });

  it("fails closed for vibes acceptance when manager authorization is not wired", async () => {
    const fetchMock = stubSuccessfulFetch();
    const msg = makeMessage({ content: "[OK]" });

    await handleMessage(makeDeps("codex-cli"), msg);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("受け入れ権限"),
    }));
  });
});

function stubSuccessfulFetch() {
  const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeDeps(provider: string): IngressDeps {
  return {
    configRepo: { all: vi.fn(() => ({})) } as unknown as IngressDeps["configRepo"],
    sessionChannelsRepo: {
      findByChannelId: vi.fn(() => ({ session_id: "s1", channel_id: "chan1", status: "active" })),
    } as unknown as IngressDeps["sessionChannelsRepo"],
    sessionsRepo: {
      findSession: vi.fn(() => ({ id: "s1", provider, status: "active", repo_path: "/repo" })),
      listSessions: vi.fn(() => []),
      mergeMetadata: vi.fn(),
    } as unknown as IngressDeps["sessionsRepo"],
    concordiaUrl: "http://concordia.test",
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

function makeMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    author: { bot: false, id: "user1", username: "User" },
    guildId: "guild1",
    channelId: "chan1",
    id: "msg1",
    channel: { type: ChannelType.GuildText, send: vi.fn() },
    content: "hello",
    member: { nickname: "Kazumi" },
    react: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Message;
}
