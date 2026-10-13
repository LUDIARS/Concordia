import { ChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordCommandDeps } from "../command-port.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "../forum-system-tag.js";
import spawnCommand from "./spawn.js";

function makeInteraction(availableTags = [{ id: "managed-tag", name: CONCORDIA_MANAGED_FORUM_TAG_NAME }]) {
  const edit = vi.fn(async () => undefined);
  const thread = {
    id: "thread-1",
    type: ChannelType.PublicThread,
    parentId: "forum-1",
    appliedTags: ["work-tag"],
    parent: { type: ChannelType.GuildForum, availableTags },
    isThread: () => true,
    fetch: async () => thread,
    edit,
  };
  return {
    channelId: "thread-1",
    channel: thread,
    guildId: "guild-1",
    user: { id: "123456789" },
    options: {
      getString: (name: string) => name === "template" ? "sol-mid" : null,
      getBoolean: () => null,
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    edit,
  };
}

function makeDeps(): DiscordCommandDeps {
  return {
    concordiaUrl: "http://127.0.0.1:11111",
    sessionsRepo: {} as DiscordCommandDeps["sessionsRepo"],
    sessionChannelsRepo: {
      listActive: vi.fn(() => []),
    } as unknown as DiscordCommandDeps["sessionChannelsRepo"],
    pendingQuestionsRepo: {} as DiscordCommandDeps["pendingQuestionsRepo"],
    guild: {} as DiscordCommandDeps["guild"],
    layout: { sessionForumId: "forum-1" } as DiscordCommandDeps["layout"],
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

describe("/spawn Forum marker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds the Cc-managed tag before the direct admin spawn request", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({ error: "test stop" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeInteraction();

    await spawnCommand.execute(interaction as never, makeDeps());

    expect(interaction.edit).toHaveBeenCalledWith({
      appliedTags: ["work-tag", "managed-tag"],
      reason: "Concordia explicit spawn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://127.0.0.1:11111/v1/admin/spawn-session");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("/v1/delegation/invoke");
  });

  it("fails closed and never calls the spawn API when the managed tag is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeInteraction([]);

    await spawnCommand.execute(interaction as never, makeDeps());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("Cc 管理タグを付与できませんでした"),
    });
  });
});

// 2026-10-14 neco 指示: /spawn は Delegation テンプレート起動専用。 指定は template → site → project の 3 つだけ。
describe("/spawn Delegation 起動", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeChannelInteraction(options: Record<string, string | null>) {
    return {
      channelId: "channel-1",
      channel: { isThread: () => false, parentId: null },
      guildId: "guild-1",
      user: { id: "123456789" },
      options: { getString: (name: string) => options[name] ?? null, getBoolean: () => null },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async (_payload: { content?: string; ephemeral?: boolean }) => undefined),
    };
  }

  it("指定は template (必須) → site → project の 3 つだけ", () => {
    const json = spawnCommand.builder.toJSON() as { options?: Array<{ name: string; required?: boolean }> };
    expect(json.options?.map((o) => o.name)).toEqual(["template", "site", "project"]);
    expect(json.options?.[0]?.required).toBe(true);
  });

  it("テンプレートの prompt を注入せず、 template と project だけで起動を依頼する", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => String(input).endsWith("/v1/admin/spawn-session")
      ? new Response(JSON.stringify({ ok: true, pid: 3 }), { status: 200 })
      : new Response(JSON.stringify({ templates: [{ call_name: "opus-5-5", title: "Opus", target_provider: "claude", is_active: true }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeChannelInteraction({ template: "opus-5-5", project: "Concordia" });

    await spawnCommand.execute(interaction as never, {
      ...makeDeps(),
      sessionChannelsRepo: {
        listActive: vi.fn().mockReturnValueOnce([]).mockReturnValue([{ session_id: "s-new", channel_id: "c-new" }]),
      } as unknown as DiscordCommandDeps["sessionChannelsRepo"],
    });

    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1/admin/spawn-session"));
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ template: "opus-5-5", inject_prompt: false, project: "Concordia" });
    expect(body).not.toHaveProperty("prompt");
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("options");
    expect(body).not.toHaveProperty("memoria_task_id");
  });

  it("子会社の担当外 project は起動しない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeChannelInteraction({ template: "opus-5-5", project: "Cernere" });

    await spawnCommand.execute(interaction as never, {
      ...makeDeps(),
      subsidiaryId: "sub-1",
      resolveSubsidiaryProjects: () => ["Concordia"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(String(interaction.reply.mock.calls[0]?.[0]?.content ?? "")).toContain("担当範囲外");
  });
});