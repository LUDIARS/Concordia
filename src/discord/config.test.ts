import { describe, it, expect } from "vitest";
import { ChannelType } from "discord.js";
import type { Guild } from "discord.js";
import { ensureDiscordLayout, SESSION_FORUM_TOPIC, TEST_FORUM_TOPIC } from "./config.js";
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
    edit?: (patch: { topic?: string; parent?: string | null }) => Promise<void>;
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
          edit: async (patch: { topic?: string; parent?: string | null }) => {
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
  it("既定 (本社) は雑談 meta / pr-queue / errors を全部作る", async () => {
    const { guild, created, channels } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo());

    expect(snap.prQueueChannelId).not.toBe("");
    expect(snap.errorChannelId).not.toBe("");
    expect(snap.errorCategoryId).not.toBe("");
    expect(Object.keys(snap.metaChannels).length).toBeGreaterThan(0);
    expect(snap.forumMode).toBe(true);
    expect(snap.sessionForumId).not.toBe("");
    expect(snap.testForumId).not.toBe("");
    expect(snap.taskWorkflowForumId).not.toBe("");

    const names = created.map((c) => c.name);
    expect(names).toContain("pr-queue");
    expect(names).toContain("errors");
    expect(names).toContain("雑談");
    expect(names).not.toContain("sessions");
    expect(names).not.toContain("archive");
    expect(channels.get(snap.costChannelId)?.parentId).toBeNull();
    expect(channels.get(snap.activityChannelId)?.parentId).toBe(snap.statusCategoryId);
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

  it("slim (子会社) は雑談 meta / pr-queue / errors を作らず空 id を返す", async () => {
    const { guild, created } = makeFakeGuild();
    const snap = await ensureDiscordLayout(guild, makeFakeRepo(), {
      includeMetaChannels: false,
      includePrQueue: false,
      includeErrors: false,
    });

    expect(snap.prQueueChannelId).toBe("");
    expect(snap.errorChannelId).toBe("");
    expect(snap.errorCategoryId).toBe("");
    expect(Object.keys(snap.metaChannels).length).toBe(0);

    // meta カテゴリ自体は受付チャンネルの親として残す。
    expect(snap.metaCategoryId).not.toBe("");

    const names = created.map((c) => c.name);
    expect(names).not.toContain("pr-queue");
    expect(names).not.toContain("errors");
    expect(names).not.toContain("雑談");
    // セッション系 (コスト / monitor) は子会社でも作る。
    expect(names).toContain("concordia-monitor");
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
    expect(forum?.topic).toBe(SESSION_FORUM_TOPIC);
    expect(SESSION_FORUM_TOPIC).toContain("起動テンプレタグを1つ");
    expect(SESSION_FORUM_TOPIC).toContain("[project code]");
    expect(SESSION_FORUM_TOPIC).toContain("Ccがセッションをspawn");
    expect(SESSION_FORUM_TOPIC).toContain("同じスレッド");
  });
});
