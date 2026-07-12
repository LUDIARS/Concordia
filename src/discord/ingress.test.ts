import { ChannelType, type Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReplySpawnChatPayload,
  handleMessage,
  resolveMetaKind,
  type IngressDeps,
} from "./ingress.js";
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
  it("binds reply-spawn visibility posts to the source session", () => {
    expect(buildReplySpawnChatPayload("s1", "do the work", "chan1")).toMatchObject({
      channel: "報告",
      session_id: "s1",
      text: "do the work",
      discord_channel_id: "chan1",
    });
  });

  it("recognizes the configured boyaki meta channel", () => {
    const configRepo = {
      all: vi.fn(() => ({ boyaki_channel_id: "boyaki-1" })),
    } as unknown as IngressDeps["configRepo"];
    expect(resolveMetaKind(configRepo, "boyaki-1")).toBe("boyaki");
  });
});

function stubSuccessfulFetch() {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
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
