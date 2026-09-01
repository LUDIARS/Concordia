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

// 2026-09-01 neco 指示 1: 子会社でも /spawn は使えるが、起動先は関係プロジェクトに閉じる
// (spec/feature/subsidiary-delegation.md §3.4)。 起動者の役職判定は dispatchInteraction 側。
describe("/spawn 子会社の担当プロジェクト", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * spawn 後の待受は新しいセッションチャンネルが現れるまで最大 12 秒ポーリングする。
   * 起動が通る経路のテストでは 1 回目 (knownIds 収集) の後に行が現れる形にする。
   */
  function makeSpawningDeps(patch: Partial<DiscordCommandDeps> = {}): DiscordCommandDeps {
    return {
      ...makeDeps(),
      sessionChannelsRepo: {
        listActive: vi.fn()
          .mockReturnValueOnce([])
          .mockReturnValue([{ session_id: "s-new", channel_id: "c-new" }]),
      } as unknown as DiscordCommandDeps["sessionChannelsRepo"],
      ...patch,
    };
  }

  /** template ではなく provider + project 指定の経路 (子会社の想定操作)。 */
  function makeSubsidiaryInteraction(options: Record<string, string | null>) {
    return {
      channelId: "channel-1",
      channel: { isThread: () => false, parentId: null },
      guildId: "guild-sub",
      user: { id: "123456789" },
      options: {
        getString: (name: string) => options[name] ?? null,
        getBoolean: () => null,
      },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async (_payload: { content?: string; ephemeral?: boolean }) => undefined),
    };
  }

  it("子会社では Memoria task 候補を列挙しない", async () => {
    const listOpenTasks = vi.fn();
    const respond = vi.fn(async () => undefined);

    await spawnCommand.autocomplete?.({
      guildId: "guild-sub",
      channelId: "channel-1",
      options: { getFocused: () => ({ name: "task", value: "" }) },
      respond,
    } as never, {
      ...makeDeps(),
      subsidiaryId: "sub-1",
      memoria: { listOpenTasks },
    });

    expect(listOpenTasks).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith([]);
  });

  it("子会社の team 候補は同じ子会社の行だけを使う", async () => {
    const respond = vi.fn(async () => undefined);
    const list = vi.fn(() => [{ id: "head", name: "Head", slug: "head" }]);
    const listForSubsidiary = vi.fn(() => [{ id: "sub-team", name: "Subsidiary", slug: "sub" }]);

    await spawnCommand.autocomplete?.({
      guildId: "guild-sub",
      channelId: "channel-1",
      options: { getFocused: () => ({ name: "team", value: "" }) },
      respond,
    } as never, {
      ...makeDeps(),
      subsidiaryId: "sub-1",
      teams: { list, listForSubsidiary } as unknown as DiscordCommandDeps["teams"],
    });

    expect(list).not.toHaveBeenCalled();
    expect(listForSubsidiary).toHaveBeenCalledWith("sub-1");
    expect(respond).toHaveBeenCalledWith([{ name: "Subsidiary (sub)", value: "sub-team" }]);
  });

  it("担当プロジェクトなら起動まで進む", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 42 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeSubsidiaryInteraction({ provider: "claude", project: "Concordia" });

    await spawnCommand.execute(interaction as never, makeSpawningDeps({
      subsidiaryId: "sub-1",
      resolveSubsidiaryProjects: () => ["Concordia"],
    }));

    expect(fetchMock).toHaveBeenCalled();
  });

  it("担当外の project は起動せず、許可集合も対象名も返さない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeSubsidiaryInteraction({ provider: "claude", project: "Cernere" });

    await spawnCommand.execute(interaction as never, {
      ...makeDeps(),
      subsidiaryId: "sub-1",
      resolveSubsidiaryProjects: () => ["Concordia"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const content = String(interaction.reply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("担当範囲外");
    expect(content).not.toContain("Concordia");
    expect(content).not.toContain("Cernere");
  });

  it("cwd の直接指定は受け付けない (project 集合と突き合わせられない)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeSubsidiaryInteraction({
      provider: "claude",
      project: "Concordia",
      cwd: "C:/workspace/Cernere",
    });

    await spawnCommand.execute(interaction as never, {
      ...makeDeps(),
      subsidiaryId: "sub-1",
      resolveSubsidiaryProjects: () => ["Concordia"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("scope resolver 未配線の子会社は本社相当にせず fail-closed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeSubsidiaryInteraction({ provider: "claude", project: "Concordia" });

    await spawnCommand.execute(interaction as never, { ...makeDeps(), subsidiaryId: "sub-1" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("担当プロジェクト設定を確認できない"),
    }));
  });

  it("子会社では scope の無い Memoria task を指定できない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeSubsidiaryInteraction({
      provider: "claude",
      project: "Concordia",
      task: "1737",
    });

    await spawnCommand.execute(interaction as never, {
      ...makeDeps(),
      subsidiaryId: "sub-1",
      resolveSubsidiaryProjects: () => ["Concordia"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("`task`"),
      ephemeral: true,
    }));
  });

  it("本社 (subsidiaryId 無し) は従来どおり cwd 指定で起動できる", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 7 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const interaction = makeSubsidiaryInteraction({ provider: "claude", cwd: "C:/workspace/Cernere" });

    await spawnCommand.execute(interaction as never, makeSpawningDeps());

    expect(fetchMock).toHaveBeenCalled();
  });
});
