import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { departmentSessionForumId, ensureDepartmentForum, needsDepartmentForum, type DepartmentForumTarget } from "./department-forum.js";

function department(patch: Partial<DepartmentForumTarget> = {}): DepartmentForumTarget {
  return { id: "dept-qa", name: "技術相談課", subsidiary_id: null, discord_forum_id: null, is_default: 0, archived_at: null, ...patch };
}

describe("needsDepartmentForum", () => {
  it("only provisions active, non-default departments owned by this runtime", () => {
    expect(needsDepartmentForum(department(), null)).toBe(true);
    expect(needsDepartmentForum(department({ is_default: 1 }), null)).toBe(false);
    expect(needsDepartmentForum(department({ archived_at: 1 }), null)).toBe(false);
    expect(needsDepartmentForum(department(), "glab")).toBe(false);
  });
});

describe("departmentSessionForumId", () => {
  it("uses the department forum and falls back otherwise", () => {
    expect(departmentSessionForumId(department({ discord_forum_id: "forum-qa" }), null, "session-forum")).toBe("forum-qa");
    expect(departmentSessionForumId(department(), null, "session-forum")).toBe("session-forum");
    expect(departmentSessionForumId(department({ discord_forum_id: "forum-qa", is_default: 1 }), null, "session-forum")).toBe("session-forum");
    expect(departmentSessionForumId(department({ discord_forum_id: "forum-qa" }), "glab", "session-forum")).toBe("session-forum");
    expect(departmentSessionForumId(null, null, "session-forum")).toBe("session-forum");
  });
});

function fakeForum(id: string, name: string, parentId: string) {
  return {
    id, name, parentId, type: ChannelType.GuildForum, availableTags: [],
    setName: vi.fn(async function (this: { name: string }, next: string) { this.name = next; return this; }),
    setAvailableTags: vi.fn(async () => undefined),
  };
}

describe("ensureDepartmentForum", () => {
  it("creates the category and the forum once, then reuses them", async () => {
    const channels = new Map<string, unknown>();
    let nextId = 1;
    const guild = {
      channels: {
        cache: { find: (predicate: (channel: never) => boolean) => [...channels.values()].find((channel) => predicate(channel as never)) },
        fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
        create: vi.fn(async (options: { name: string; type: ChannelType; parent?: string }) => {
          const id = `ch-${nextId++}`;
          const channel = options.type === ChannelType.GuildForum
            ? fakeForum(id, options.name, options.parent ?? "")
            : { id, name: options.name, type: options.type };
          channels.set(id, channel);
          return channel;
        }),
      },
    };
    let categoryId: string | null = null;
    const forums = new Map<string, string>();
    const store = {
      categoryId: () => categoryId,
      setCategoryId: (id: string) => { categoryId = id; },
      setForumId: (departmentId: string, forumId: string) => { forums.set(departmentId, forumId); },
    };

    const first = await ensureDepartmentForum({ guild: guild as never, store, department: department() });
    expect(guild.channels.create).toHaveBeenCalledTimes(2);
    expect(categoryId).toBe("ch-1");
    expect(forums.get("dept-qa")).toBe(first);

    const second = await ensureDepartmentForum({
      guild: guild as never, store, department: department({ discord_forum_id: first, name: "技術相談課 (改)" }),
    });
    expect(second).toBe(first);
    expect(guild.channels.create).toHaveBeenCalledTimes(2);
    expect((channels.get(first) as { name: string }).name).toBe("技術相談課 (改)");
  });
});
