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

  it("recognizes the configured Genius meta channel", () => {
    const configRepo = {
      all: vi.fn(() => ({ genius_channel_id: "genius-1" })),
    } as unknown as IngressDeps["configRepo"];
    expect(resolveMetaKind(configRepo, "genius-1")).toBe("genius");
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

  it("starts a standalone emoji workflow in a session thread without a chat target", async () => {
    const deps = makeDeps("codex-cli");
    const handle = vi.fn(async () => undefined);
    deps.workflow = { handle };
    deps.isWorkflowUserAllowed = () => true;
    deps.sessionChannelsRepo.findByChannelId = vi.fn(() => ({
      session_id: "s1",
      channel_id: "chan1",
      channel_kind: "thread",
      status: "active",
    })) as never;
    const msg = makeMessage({
      content: "🙏",
      channel: { type: ChannelType.PublicThread, parentId: "forum1", send: vi.fn() },
    });

    await handleMessage(deps, msg);

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "discord",
        sourceMessageId: "msg1",
        emoji: "🙏",
        sessionId: "s1",
        messageText: "",
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("does not start a standalone emoji workflow in a legacy session channel", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("codex-cli");
    const handle = vi.fn(async () => undefined);
    deps.workflow = { handle };
    deps.isWorkflowUserAllowed = () => true;

    await handleMessage(deps, makeMessage({ content: "🙏" }));

    expect(handle).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stores image attachments and adds their local paths to the inject", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    deps.storeImages = vi.fn(async () => ["C:\\Temp\\discord-image.png"]);
    const attachments = new Map([["image-1", {
      contentType: "image/png",
      name: "capture.png",
      size: 123,
      url: "https://cdn.discordapp.com/attachments/1/2/capture.png",
    }]]);

    await handleMessage(deps, makeMessage({ content: "この画面を確認して", attachments }));

    expect(deps.storeImages).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "msg1",
      sessionId: "s1",
    }));
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { text: string };
    expect(body.text).toContain("この画面を確認して");
    expect(body.text).toContain("C:\\Temp\\discord-image.png");
  });

  it("injects an image-only Discord message instead of dropping empty content", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    deps.storeImages = vi.fn(async () => ["C:\\Temp\\discord-image.png"]);
    const attachments = new Map([["image-1", {
      contentType: "image/png",
      name: "capture.png",
      size: 123,
      url: "https://cdn.discordapp.com/attachments/1/2/capture.png",
    }]]);

    await handleMessage(deps, makeMessage({ content: "", attachments }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { text: string };
    expect(body.text).toContain("添付画像の内容を読み取って対応してください");
  });

  it("rejects an unsupported image instead of silently injecting the accompanying text", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    deps.storeImages = vi.fn(async () => {
      throw new Error("EACCES: C:\\private\\image.svg");
    });
    const attachments = new Map([["image-1", {
      contentType: "image/svg+xml",
      name: "capture.svg",
      size: 123,
      url: "https://cdn.discordapp.com/attachments/1/2/capture.svg",
    }]]);
    const msg = makeMessage({ content: "この画像を確認して", attachments });

    await handleMessage(deps, msg);

    expect(deps.storeImages).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "画像をセッションへ渡せませんでした: 画像の取得または保存中に内部エラーが発生しました",
    }));
    expect(deps.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("C:\\private"));
  });

  it("injects Discord embed text and proxied images even when message content is empty", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    deps.storeImages = vi.fn(async () => ["C:\\Temp\\discord-embed.png"]);
    const embeds = [{
      author: { name: "Status bot" },
      provider: null,
      title: "Build result",
      description: "Open the preview and diagnose the failure.",
      url: "https://example.com/report",
      fields: [{ name: "status", value: "failed", inline: true }],
      image: {
        url: "https://example.com/image.png",
        proxyURL: "https://media.discordapp.net/external/token/image.png",
      },
      thumbnail: null,
    }];

    await handleMessage(deps, makeMessage({ content: "", embeds }));

    expect(deps.storeImages).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({
        size: null,
        url: "https://media.discordapp.net/external/token/image.png",
      })],
      messageId: "msg1",
      sessionId: "s1",
    }));
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { text: string };
    expect(body.text).toContain("Discord embed の内容を確認して対応してください");
    expect(body.text).toContain("title: Build result");
    expect(body.text).toContain("field status: failed");
    expect(body.text).toContain("C:\\Temp\\discord-embed.png");
  });

  it("injects a text-only embed instead of treating it as an empty message", async () => {
    const fetchMock = stubSuccessfulFetch();
    const deps = makeDeps("claude-code");
    const embeds = [{
      author: null,
      provider: { name: "Build service" },
      title: "Deployment complete",
      description: "Version 42 is live.",
      url: "https://example.com/releases/42",
      fields: [],
      footer: { text: "production" },
      timestamp: "2026-08-23T01:00:00.000Z",
      image: null,
      thumbnail: null,
      video: null,
    }];

    await handleMessage(deps, makeMessage({ content: "", embeds }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { text: string };
    expect(body.text).toContain("title: Deployment complete");
    expect(body.text).toContain("footer: production");
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

// 2026-09-01 neco 指示 3: Session forum の聞き返しへの返信は、 inject にもチャットにも
// 載せず、 その場で spawn を再開する回答として取り込む。
describe("Session forum の不足情報への返信", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeThreadDeps(handled: boolean) {
    const handleForumSpawnIntakeReply = vi.fn(async () => handled);
    const deps: IngressDeps = {
      ...makeDeps("claude-code"),
      // Session forum のスレッドはまだセッションを持たない。
      sessionChannelsRepo: {
        findByChannelId: vi.fn(() => null),
      } as unknown as IngressDeps["sessionChannelsRepo"],
      handleForumSpawnIntakeReply,
    };
    return { deps, handleForumSpawnIntakeReply };
  }

  const threadMessage = () => makeMessage({
    channelId: "thread-1",
    id: "reply-1",
    content: "Concordia の受付文言を直して",
    channel: { type: ChannelType.PublicThread, parentId: "forum-1", send: vi.fn() },
  });

  it("回答として取り込まれたら通常経路へ流さない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, handleForumSpawnIntakeReply } = makeThreadDeps(true);

    await handleMessage(deps, threadMessage());

    expect(handleForumSpawnIntakeReply).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild1",
      channelId: "thread-1",
      messageId: "reply-1",
      authorId: "user1",
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("対象外なら従来どおり素通しする", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { deps, handleForumSpawnIntakeReply } = makeThreadDeps(false);

    await handleMessage(deps, threadMessage());

    expect(handleForumSpawnIntakeReply).toHaveBeenCalledOnce();
    // ルーティング先の無いチャンネルなので何も起きない (例外にしない)。
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith(expect.stringContaining("no routing target"));
  });

  it("回答の取り込みが失敗しても投稿を落とさない", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { deps } = makeThreadDeps(false);
    deps.handleForumSpawnIntakeReply = vi.fn(async () => { throw new Error("thread gone"); });

    await handleMessage(deps, threadMessage());

    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("intake reply failed"));
  });
});

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
    attachments: new Map(),
    embeds: [],
    member: { nickname: "Kazumi" },
    react: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Message;
}
