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
    options: {
      getString: (name: string) => name === "template" ? "codex-5-6-sol" : null,
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
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:11111/v1/admin/spawn-session");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/v1/delegation/invoke");
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
