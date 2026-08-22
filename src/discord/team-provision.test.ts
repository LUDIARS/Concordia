import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ensureTeamDiscordLayout } from "./team-provision.js";

interface FakeTag { id: string; name: string; moderated: boolean; emoji?: unknown }

interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  availableTags: FakeTag[];
  setName: (name: string) => Promise<FakeChannel>;
  setAvailableTags: (tags: Array<{ id?: string; name: string; moderated: boolean }>) => Promise<FakeChannel>;
}

function makeGuild() {
  const channels: FakeChannel[] = [];
  let seq = 0;
  let tagSeq = 0;
  const create = vi.fn(async (opts: { name: string; type: ChannelType; parent?: string }) => {
    const channel: FakeChannel = {
      id: `ch-${++seq}`,
      name: opts.name,
      type: opts.type,
      parentId: opts.parent ?? null,
      // Discord が新規 forum に自動でタグを付けないのと同じく、既定は空。
      availableTags: [],
      setName: async function (this: FakeChannel, name: string) { this.name = name; return this; },
      setAvailableTags: async function (this: FakeChannel, tags) {
        this.availableTags = tags.map((tag) => ({
          id: tag.id ?? `tag-${++tagSeq}`,
          name: tag.name,
          moderated: tag.moderated,
        }));
        return this;
      },
    };
    channels.push(channel);
    return channel;
  });
  const guild = {
    channels: {
      cache: { find: (fn: (c: FakeChannel) => boolean) => channels.find(fn) },
      fetch: vi.fn(async (id: string) => {
        const found = channels.find((c) => c.id === id);
        if (!found) throw new Error("Unknown Channel");
        return found;
      }),
      create,
    },
  };
  // ensureTeamDiscordLayout が使う channels.fetch / cache.find / create だけを備えた fake。
  return { guild: guild as any, channels, create };
}

function makeTeamDb(teamId = "team-1", name = "チームA") {
  const db = makeTestDb();
  db.prepare(
    "INSERT INTO teams(id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(teamId, name, "team-a", 1, 1);
  return db;
}

function surfaceRows(db: ReturnType<typeof makeTeamDb>, teamId = "team-1") {
  return db.prepare("SELECT surface, channel_id FROM team_surfaces WHERE team_id = ? ORDER BY surface").all(teamId) as
    Array<{ surface: string; channel_id: string }>;
}

describe("ensureTeamDiscordLayout", () => {
  it("初回はカテゴリ + 6 面を作成し ID を保存する", async () => {
    const { guild, channels } = makeGuild();
    const db = makeTeamDb();
    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });

    const category = channels.find((c) => c.type === ChannelType.GuildCategory)!;
    expect(category.name).toBe("チームA");
    const stored = db.prepare("SELECT discord_category_id FROM teams WHERE id = ?").get("team-1") as { discord_category_id: string };
    expect(stored.discord_category_id).toBe(category.id);

    const rows = surfaceRows(db);
    expect(rows).toHaveLength(6);
    const byName = new Map(channels.filter((c) => c !== category).map((c) => [c.name, c]));
    expect(byName.get("セッションフォーラム")?.type).toBe(ChannelType.GuildForum);
    expect(byName.get("タスクフォーラム")?.type).toBe(ChannelType.GuildForum);
    for (const surface of ["目標", "タスクボード", "コスト", "direction"]) {
      expect(byName.get(surface)?.type).toBe(ChannelType.GuildText);
    }
    for (const channel of channels) {
      if (channel === category) continue;
      expect(channel.parentId).toBe(category.id);
    }
  });

  it("チーム forum にセッションスレッド生成の必須タグを用意する", async () => {
    const { guild, channels } = makeGuild();
    const db = makeTeamDb();
    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });

    // createForumSessionThread は状態タグ (待機) と Cc管理タグが無い forum に対して throw し、
    // onSessionRegistered がそれを握り潰すため、面が一切作られなくなる。
    for (const forumName of ["セッションフォーラム", "タスクフォーラム"]) {
      const forum = channels.find((c) => c.name === forumName)!;
      const tagNames = forum.availableTags.map((tag) => tag.name);
      expect(tagNames).toEqual(expect.arrayContaining(["作業中", "待機", "lost", "Cc管理"]));
    }
  });

  it("タグ無しで作られた既存チーム forum にも不足タグを後追いで補う", async () => {
    const { guild, channels } = makeGuild();
    const db = makeTeamDb();
    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });

    // 旧バージョンが作った (= タグ無しの) forum を再現する。
    const forum = channels.find((c) => c.name === "セッションフォーラム")!;
    forum.availableTags = [{ id: "user-tag", name: "利用者タグ", moderated: false }];

    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });
    const tagNames = forum.availableTags.map((tag) => tag.name);
    expect(tagNames).toEqual(expect.arrayContaining(["作業中", "待機", "lost", "Cc管理"]));
    // 利用者が付けた既存タグは落とさない。
    expect(tagNames).toContain("利用者タグ");
  });

  it("再実行しても保存済み ID を再利用し重複作成しない (冪等)", async () => {
    const { guild, channels, create } = makeGuild();
    const db = makeTeamDb();
    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });
    const firstRows = surfaceRows(db);
    const createdOnce = create.mock.calls.length;

    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });
    expect(create.mock.calls.length).toBe(createdOnce);
    expect(channels).toHaveLength(7);
    expect(surfaceRows(db)).toEqual(firstRows);
  });

  it("面が部分的に消えていたら欠落分だけ補完する", async () => {
    const { guild, channels, create } = makeGuild();
    const db = makeTeamDb();
    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });
    const before = new Map(surfaceRows(db).map((row) => [row.surface, row.channel_id]));

    // コスト channel を Discord 側から消す (DB には旧 ID が残る)。
    const lost = channels.findIndex((c) => c.name === "コスト");
    channels.splice(lost, 1);
    const createdBefore = create.mock.calls.length;

    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });
    expect(create.mock.calls.length).toBe(createdBefore + 1);
    const after = new Map(surfaceRows(db).map((row) => [row.surface, row.channel_id]));
    expect(after.get("コスト")).not.toBe(before.get("コスト"));
    for (const surface of ["目標", "タスクボード", "direction", "セッション", "タスク"]) {
      expect(after.get(surface)).toBe(before.get(surface));
    }
  });

  it("チーム名変更は保存済みカテゴリを rename して引き継ぐ", async () => {
    const { guild, channels, create } = makeGuild();
    const db = makeTeamDb();
    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });
    const category = channels.find((c) => c.type === ChannelType.GuildCategory)!;
    const createdBefore = create.mock.calls.length;

    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA改" });
    expect(category.name).toBe("チームA改");
    expect(create.mock.calls.length).toBe(createdBefore);
  });

  it("保存 ID が無いとき同名の無関係カテゴリを乗っ取らない", async () => {
    const { guild, channels } = makeGuild();
    const db = makeTeamDb();
    // 無関係の同名カテゴリが既に存在する。
    const unrelated: FakeChannel = await guild.channels.create({ name: "チームA", type: ChannelType.GuildCategory });

    await ensureTeamDiscordLayout({ guild, db, teamId: "team-1", name: "チームA" });
    const stored = db.prepare("SELECT discord_category_id FROM teams WHERE id = ?").get("team-1") as { discord_category_id: string };
    expect(stored.discord_category_id).not.toBe(unrelated.id);
    expect(channels.filter((c) => c.type === ChannelType.GuildCategory)).toHaveLength(2);
  });
});
