import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import {
  buildForumSpawnPrompt,
  buildForumSpawnTrigger,
  handleForumSpawnThread,
  parseForumSpawnTrigger,
  selectForumSpawnTemplate,
  type ForumSpawnThread,
} from "./forum-spawn.js";

function template(title: string): DelegationTemplateLite {
  return {
    call_name: title.toLowerCase(),
    title,
    is_active: true,
    call_only: false,
    emoji: "",
    forum_tag: true,
    input_schema: [],
    default_cwd: null,
    project: null,
  };
}

describe("forum spawn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves exactly one applied template tag", () => {
    const tags = [{ id: "a", name: "Implement" }, { id: "b", name: "Review" }];
    expect(selectForumSpawnTemplate(["a"], tags, [template("Implement"), template("Review")])).toMatchObject({
      kind: "selected",
      template: { call_name: "implement" },
    });
    expect(selectForumSpawnTemplate([], tags, [template("Implement")])).toEqual({ kind: "missing" });
    expect(selectForumSpawnTemplate(["a", "b"], tags, [template("Implement"), template("Review")])).toEqual({
      kind: "ambiguous",
      names: ["Implement", "Review"],
    });
  });

  it("round-trips the persistent thread correlation trigger", () => {
    const trigger = buildForumSpawnTrigger("guild", "thread");
    expect(trigger).toBe("discord-forum:guild:thread");
    expect(parseForumSpawnTrigger(trigger)).toEqual({ guildId: "guild", threadId: "thread" });
    expect(parseForumSpawnTrigger("discord-forum:guild:thread:extra")).toBeNull();
  });

  it("includes both title and body in the initial injected prompt", () => {
    expect(buildForumSpawnPrompt("[Cc] Phase 2", "Implement spawn-by-post")).toContain(
      "Title: [Cc] Phase 2\n\nImplement spawn-by-post",
    );
  });

  it("invokes the selected template once with a persistent thread trigger", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      run: { id: "run-1", status: "queued" },
      spawn_pid: 42,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const replies: string[] = [];
    const thread: ForumSpawnThread = {
      id: "thread-1",
      guildId: "guild-1",
      parentId: "forum-1",
      ownerId: "human-1",
      name: "[Cc] Implement Phase 2",
      appliedTags: ["tag-1"],
      parent: { availableTags: [{ id: "tag-1", name: "Implement" }] },
      fetchStarterMessage: async () => ({ content: "Build spawn-by-post" }),
      send: async ({ content }) => { replies.push(content); },
    };

    await handleForumSpawnThread({
      sessionForumId: "forum-1",
      botUserId: "bot-1",
      concordiaUrl: "http://127.0.0.1:17320",
      templates: async () => [template("Implement")],
      resolveProjectTarget: () => ({ project: "Cc", code: "Cc", cwd: "E:/Document/Ars/Concordia" }),
      hasExistingRun: () => false,
      log: { info: vi.fn(), warn: vi.fn() },
    }, thread);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:17320/v1/delegation/invoke");
    expect(JSON.parse(String(init.body))).toMatchObject({
      call_name: "implement",
      cwd: "E:/Document/Ars/Concordia",
      triggered_by: "discord-forum:guild-1:thread-1",
      spawn: true,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("run-1");
  });
});
