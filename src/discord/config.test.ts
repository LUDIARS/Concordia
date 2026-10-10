import { describe, it, expect } from "vitest";
import { ChannelType } from "discord.js";
import type { Guild } from "discord.js";
import { detachFromCategory, ensureDeskChannel, ensureDiscordLayout, SESSION_FORUM_TOPIC, TEST_FORUM_TOPIC } from "./config.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";

/** ensureDiscordLayout 用の最小 fake Guild / repo。 channels.create を記録する。 */
function makeFakeGuild() {
  const channels = new Map<string, {
    id: string;
    name: string;
    type: ChannelType;
    parentId: string | null;
    topic: string | null;
    availableTags?: Array<{ id: string; name: string; moderated: boolean; emoji: undefined }>;
    setAvailableTags?: (tags: Array<{ id?: string; name: string; moderated?: boolean }>) => Promise<void>;
    edit?: (patch: { name?: string; topic?: string; parent?: string | null }) => Promise<void>;
  }>();
  let counter = 0;
  const created: Array<{ name: string; type: ChannelType; topic: string | null }> = [];
  const guild = {
    id: "guild-1",
    channels: {
      cache: {
        get: (id: string) => channels.get(id),
        find: (fn: (c: { id: string; name: string; type: ChannelType; parentId: string | null }) => boolean) => {
          for (const c of channels.values()) if (fn(c)) return c;
          return undefined;
        },
      },
      create: async ({ name, type, parent, topic }: { name: string; type: ChannelType; parent?: string; topic?: string }) => {
        const id = `ch-${counter++}`;
        const ch = {
          id,
          name,
          type,
          parentId: parent ?? null,
          topic: topic ?? null,
          availableTags: [] as Array<{ id: string; name: string; moderated: boolean; emoji: undefined }>,
          setAvailableTags: async (tags: Array<{ id?: string; name: string; moderated?: boolean }>) => {
            ch.availableTags = tags.map((tag, index) => ({
              id: tag.id ?? `${id}-tag-${index}`,
              name: tag.name,
              moderated: tag.moderated ?? false,
              emoji: undefined,
            }));
          },
          edit: async (patch: { name?: string; topic?: string; parent?: string | null }) => {
            if (patch.name !== undefined) ch.name = patch.name;
            if (patch.topic !== undefined) ch.topic = patch.topic;
            if (patch.parent !== undefined) ch.parentId = patch.parent;
          },
        };
        channels.set(id, ch);
        created.push({ name, type, topic: topic ?? null });
        return ch;
      },
    },
  } as unknown as Guild;
  return { guild, created, channels };
}

function makeFakeRepo(): DiscordConfigRepo {
  const store = new Map<string, string>();
  return {
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => { store.set(k, v); },
  } as unknown as DiscordConfigRepo;
}

describe("ensureDiscordLayout", () => {
  it("既定 (本社) は雑談 meta / pr-queue / チーム管理 / errors を全部作る", async () => {
    const { guild, created, channels } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo());

    expect(snap.prQueueChannelId).not.toBe("");
    expect(snap.teamAdminChannelId).not.toBe("");
    expect(snap.errorChannelId).not.toBe("");
    expect(snap.errorCategoryId).not.toBe("");
    expect(Object.keys(snap.metaChannels).length).toBeGreaterThan(0);
    expect(snap.forumMode).toBe(true);
    expect(snap.sessionForumId).not.toBe("");
    expect(snap.testForumId).not.toBe("");
    expect(snap.taskWorkflowForumId).not.toBe("");

    const names = created.map((c) => c.name);
    expect(names).toContain("pr-queue");
    expect(names).toContain("チーム管理");
    expect(names).toContain("errors");
    expect(names).toContain("雑談");
    expect(names).toContain("genius");
    expect(names).not.toContain("sessions");
    expect(names).not.toContain("archive");
    expect(channels.get(snap.costChannelId)?.parentId).toBeNull();
    expect(channels.get(snap.activityChannelId)?.parentId).toBe(snap.statusCategoryId);
    expect(channels.get(snap.serviceStatusChannelId!)?.name).toBe("サービス稼働");
    // サービス稼働はカテゴリ外 (2026-10-06 neco 指示「雑務窓口とサービス稼働はカテゴリから出す」)。
    expect(channels.get(snap.serviceStatusChannelId!)?.parentId).toBeNull();
  });

  it("Session フォーラムを既定部署の名前に揃え、 既定部署が無くなれば Session に戻す", async () => {
    const { guild, channels } = makeFakeGuild();
    const repo = makeFakeRepo();
    const first = await ensureDiscordLayout(guild, repo);
    expect(channels.get(first.sessionForumId)?.name).toBe("Session");

    const renamed = await ensureDiscordLayout(guild, repo, { sessionForumName: "総務" });
    expect(renamed.sessionForumId).toBe(first.sessionForumId);
    expect(channels.get(first.sessionForumId)?.name).toBe("総務");

    const restored = await ensureDiscordLayout(guild, repo);
    expect(restored.sessionForumId).toBe(first.sessionForumId);
    expect(channels.get(first.sessionForumId)?.name).toBe("Session");
  });

  it("保存済み id を失っても旧名の Session フォーラムを引き継ぎ、 二つ目を作らない", async () => {
    const { guild, channels, created } = makeFakeGuild();
    const first = await ensureDiscordLayout(guild, makeFakeRepo());

    const second = await ensureDiscordLayout(guild, makeFakeRepo(), { sessionForumName: "総務" });
    expect(second.sessionForumId).toBe(first.sessionForumId);
    expect(channels.get(first.sessionForumId)?.name).toBe("総務");
    expect(created.filter((c) => c.type === ChannelType.GuildForum && (c.name === "Session" || c.name === "総務"))).toHaveLength(1);

    const third = await ensureDiscordLayout(guild, makeFakeRepo(), { sessionForumName: "総務" });
    expect(third.sessionForumId).toBe(first.sessionForumId);
  });

  it("既存のコストチャンネルをカテゴリ外へ移動する", async () => {
    const { guild, channels } = makeFakeGuild();
    const repo = makeFakeRepo();
    const first = await ensureDiscordLayout(guild, repo);
    const cost = channels.get(first.costChannelId)!;
    cost.parentId = first.statusCategoryId;

    const second = await ensureDiscordLayout(guild, repo);
    expect(second.costChannelId).toBe(first.costChannelId);
    expect(cost.parentId).toBeNull();
  });

  it("slim (子会社) は雑談 meta / pr-queue / チーム管理 / errors を作らず空 id を返す", async () => {
    const { guild, created } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo(), {
      includeMetaChannels: false,
      includePrQueue: false,
      includeTeamAdmin: false,
      includeErrors: false,
    });

    expect(snap.prQueueChannelId).toBe("");
    expect(snap.teamAdminChannelId).toBe("");
    expect(snap.errorChannelId).toBe("");
    expect(snap.errorCategoryId).toBe("");
    expect(Object.keys(snap.metaChannels).length).toBe(0);

    // meta カテゴリ自体は受付チャンネルの親として残す。
    expect(snap.metaCategoryId).not.toBe("");

    const names = created.map((c) => c.name);
    expect(names).not.toContain("pr-queue");
    expect(names).not.toContain("チーム管理");
    expect(names).not.toContain("errors");
    expect(names).not.toContain("雑談");
    // セッション系 (コスト / monitor) は子会社でも作る。
    expect(names).toContain("concordia-monitor");
    expect(names).toContain("サービス稼働");
    expect(names).toContain("Session");
    expect(names).toContain("Test");
    expect(names).toContain("TaskWorkflow");
  });

  it("Test forum を PR/worktree 同期専用として作る", async () => {
    const { guild, channels } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo());

    const forum = channels.get(snap.testForumId);
    expect(forum?.name).toBe("Test");
    expect(forum?.topic).toBe(TEST_FORUM_TOPIC);
    expect(forum?.availableTags?.map((tag) => tag.name)).toEqual([
      "審査中",
      "審査失敗",
      "人間判断",
      "マージOK",
      "テストOK",
    ]);
    expect(TEST_FORUM_TOPIC).toContain("head commit");
    expect(TEST_FORUM_TOPIC).toContain("worktree");
  });

  it("Session forum に起動テンプレタグと spawn の流れを自動設定する", async () => {
    const { guild, channels } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo(), {
      sessionForumTemplates: [{
        id: "forum-claude",
        call_name: "forum-claude-session",
        title: "Claude起動",
        is_active: 1,
        forum_tag: 1,
        input_schema: [],
      }],
    });

    const forum = channels.get(snap.sessionForumId);
    expect(forum?.availableTags?.map((tag) => tag.name)).toContain("Claude起動");
    expect(forum?.availableTags?.map((tag) => tag.name)).toContain(CONCORDIA_MANAGED_FORUM_TAG_NAME);
    expect(channels.get(snap.taskWorkflowForumId)?.availableTags?.map((tag) => tag.name))
      .toContain(CONCORDIA_MANAGED_FORUM_TAG_NAME);
    expect(forum?.topic).toBe(SESSION_FORUM_TOPIC);
    expect(SESSION_FORUM_TOPIC).toContain("投稿内容からCcが起動テンプレを選択");
    expect(SESSION_FORUM_TOPIC).toContain("[project code]");
    expect(SESSION_FORUM_TOPIC).toContain("Ccがセッションをspawn");
    expect(SESSION_FORUM_TOPIC).toContain("同じスレッド");
  });

  it("渡された拠点タグを Session forum に作る", async () => {
    const { guild, channels } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo(), { sessionForumSiteTags: ["HASTER"] });
    expect(channels.get(snap.sessionForumId)?.availableTags?.map((tag) => tag.name)).toContain("HASTER");
  });

  it("Villa 停止時の空候補でも既存のタグ同期を継続する", async () => {
    const { guild, channels } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo(), { sessionForumSiteTags: [] });
    const names = channels.get(snap.sessionForumId)?.availableTags?.map((tag) => tag.name);
    expect(names).not.toContain("HASTER");
    expect(names).toContain(CONCORDIA_MANAGED_FORUM_TAG_NAME);
  });

  it("古い拠点タグで埋まった forum でも拠点タグを諦めるだけで同期は落とさない", async () => {
    const { guild, channels } = makeFakeGuild();
    const repo = makeFakeRepo();
    // 先に上限 (20 個) まで埋める。 base 9 個 + 拠点タグ 11 個。
    const old = Array.from({ length: 11 }, (_, i) => `OLD-${i}`);
    const first = await ensureDiscordLayout(guild, repo, { sessionForumSiteTags: old });
    expect(channels.get(first.sessionForumId)?.availableTags?.length).toBe(20);

    // Villa 側で PC が入れ替わっても、古いタグは残ったまま = 空きが無い。
    // 必須タグの同期ごと throw せず、新しい拠点タグだけ諦める。
    const renamed = Array.from({ length: 11 }, (_, i) => `NEW-${i}`);
    const second = await ensureDiscordLayout(guild, repo, { sessionForumSiteTags: renamed });
    const names = channels.get(second.sessionForumId)?.availableTags?.map((tag) => tag.name) ?? [];
    expect(names).not.toContain("NEW-0");
    expect(names).toContain(CONCORDIA_MANAGED_FORUM_TAG_NAME);
    expect(names).toHaveLength(20);
  });
});

describe("desk の窓口はカテゴリを持たない (2026-10-10 neco 指示)", () => {
  it("新規作成はカテゴリ外、 カテゴリ内の既存チャンネルは外へ出す", async () => {
    const { guild, channels } = makeFakeGuild();
    const repo = makeFakeRepo();
    const category = await guild.channels.create({ name: "meta", type: ChannelType.GuildCategory });
    const old = await guild.channels.create({ name: "kd窓口", type: ChannelType.GuildText, parent: category.id });
    expect(await ensureDeskChannel(guild, repo, "desk-kd", "kd窓口")).toBe(old.id);
    expect(channels.get(old.id)?.parentId).toBeNull();
    const fresh = await ensureDeskChannel(guild, repo, "desk-new", "新窓口");
    expect(channels.get(fresh)?.parentId).toBeNull();
  });
  it("保存済み id のチャンネルを detachFromCategory でカテゴリ外へ出す", async () => {
    const setParent = async (_parent: null) => { channel.parentId = null; };
    const channel = { id: "desk", name: "kd窓口", parentId: "meta" as string | null, isThread: () => false, setParent };
    const guild = { channels: { cache: new Map([["desk", channel]]), fetch: async () => null } } as unknown as Guild;
    await detachFromCategory(guild, "desk");
    expect(channel.parentId).toBeNull();
    await detachFromCategory(guild, "missing");
  });
});