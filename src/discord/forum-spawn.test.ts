import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import {
  buildForumSpawnPrompt,
  buildForumSpawnTrigger,
  handleForumSpawnThread,
  isConcordiaSessionStarter,
  parseForumSpawnTrigger,
  type ForumSpawnDeps,
  type ForumSpawnThread,
} from "./forum-spawn.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";

const MANAGED_TAG = { id: "managed-tag", name: CONCORDIA_MANAGED_FORUM_TAG_NAME };

function template(callName = "forum-codex-session"): DelegationTemplateLite {
  return {
    call_name: callName,
    title: callName,
    description: "Implement a Forum request",
    target_provider: "codex",
    model: "gpt-5.6-sol",
    is_active: true,
    call_only: false,
    emoji: "",
    forum_tag: true,
    input_schema: [{ name: "effort", type: "string", required: true, default: "high" }],
    default_cwd: null,
    project: null,
  };
}

function makeThread(patch: Partial<ForumSpawnThread> = {}): ForumSpawnThread {
  return {
    id: "thread-1",
    guildId: "guild-1",
    parentId: "forum-1",
    ownerId: "123456789",
    name: "[Cc] Implement Phase 2",
    appliedTags: [],
    availableTags: [MANAGED_TAG],
    fetchStarterMessage: vi.fn(async () => ({ content: "Build spawn-by-post" })),
    fetchTagState: vi.fn(async () => ({ appliedTags: [], availableTags: [MANAGED_TAG] })),
    ...patch,
  };
}

function makeDeps(patch: Partial<ForumSpawnDeps> = {}): ForumSpawnDeps {
  const selected = template();
  return {
    sessionForumId: "forum-1",
    botUserId: "987654321",
    concordiaUrl: "http://127.0.0.1:17320",
    isLaunchUserAllowed: (userId) => userId === "123456789",
    templates: vi.fn(async () => [selected]),
    selectTemplate: vi.fn(async () => ({ ok: true as const, template: selected })),
    resolveProjectTarget: () => ({ project: "Cc", code: "Cc", cwd: "E:/Document/Ars/Concordia" }),
    resolveSpawnCwd: (_provider, requested) => requested,
    hasExistingRun: () => false,
    postToThread: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...patch,
  };
}

describe("forum spawn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips the persistent thread correlation trigger", () => {
    const trigger = buildForumSpawnTrigger("guild", "thread");
    expect(trigger).toBe("discord-forum:guild:thread");
    expect(parseForumSpawnTrigger(trigger)).toEqual({ guildId: "guild", threadId: "thread" });
    expect(parseForumSpawnTrigger("discord-forum:guild:thread:extra")).toBeNull();
  });

  it("includes title/body and recognizes both Repo spellings in Cc starters", () => {
    expect(buildForumSpawnPrompt("[Cc] Phase 2", "Implement spawn-by-post")).toContain(
      "Title: [Cc] Phase 2\n\nImplement spawn-by-post",
    );
    expect(isConcordiaSessionStarter("**Session** `s1`\n**Repo** `Concordia`")).toBe(true);
    expect(isConcordiaSessionStarter("**TaskWorkflow** `s2`\n**Repository** `Concordia`")).toBe(true);
    expect(isConcordiaSessionStarter("Please fix **Repo** handling")).toBe(false);
  });

  it("ignores a Cc-managed thread before authorization, starter fetch, selector, or invoke", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const isLaunchUserAllowed = vi.fn(() => true);
    const deps = makeDeps({ isLaunchUserAllowed });
    const thread = makeThread({ appliedTags: ["managed-tag"] });

    await handleForumSpawnThread(deps, thread);

    expect(isLaunchUserAllowed).not.toHaveBeenCalled();
    expect(thread.fetchStarterMessage).not.toHaveBeenCalled();
    expect(deps.selectTemplate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects one active template and invokes it without overriding template runtime defaults", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      run: { id: "run-1", status: "queued" },
      spawn_pid: 42,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const selected = template("impl-from-forum");
    const deps = makeDeps({
      templates: async () => [selected],
      selectTemplate: vi.fn(async () => ({ ok: true as const, template: selected })),
    });

    await handleForumSpawnThread(deps, makeThread());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      call_name: "impl-from-forum",
      args: { effort: "high" },
      cwd: "E:/Document/Ars/Concordia",
      triggered_by: "discord-forum:guild-1:thread-1",
      spawn: true,
      subsidiary_id: null,
      project: "Cc",
      requester_discord_user_id: "123456789",
      source_discord_guild_id: "guild-1",
      source_discord_channel_id: "thread-1",
    });
    expect(body).not.toHaveProperty("overrides");
  });

  it("rechecks fresh tags immediately before invoke and yields to explicit /spawn", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const deps = makeDeps();
    const thread = makeThread({
      fetchTagState: vi.fn(async () => ({
        appliedTags: ["managed-tag"],
        availableTags: [MANAGED_TAG],
      })),
    });

    await handleForumSpawnThread(deps, thread);

    expect(deps.selectTemplate).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a starter that is not visible at ThreadCreate time", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      run: { id: "run-retry", status: "spawned" },
      spawn_pid: 45,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const fetchStarterMessage = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ content: "Cc を直す" });
    const wait = vi.fn(async () => undefined);

    await handleForumSpawnThread(makeDeps({ wait }), makeThread({ fetchStarterMessage }));

    expect(fetchStarterMessage).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("adds selected runtime rule tags to the startup prompt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      run: { id: "run-rules", status: "spawned" },
      spawn_pid: 46,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const runtimeTag = { id: "rule-web", name: "Webサービス" };
    const thread = makeThread({
      availableTags: [MANAGED_TAG, runtimeTag],
      fetchTagState: vi.fn(async () => ({
        appliedTags: [runtimeTag.id],
        availableTags: [MANAGED_TAG, runtimeTag],
      })),
    });

    await handleForumSpawnThread(makeDeps(), thread);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).extra_prompt).toContain("Active rules: Webサービス");
  });

  it("fails closed when template selection fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const deps = makeDeps({
      selectTemplate: vi.fn(async () => ({
        ok: false as const,
        error: "起動テンプレの選択に失敗しました。",
      })),
    });

    await handleForumSpawnThread(deps, makeThread());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.postToThread).toHaveBeenCalledWith("thread-1", "起動テンプレの選択に失敗しました。");
  });

  it("rejects a non-allowlisted owner before the selector", async () => {
    const deps = makeDeps({ isLaunchUserAllowed: () => false });
    await handleForumSpawnThread(deps, makeThread({ ownerId: "human-denied" }));
    expect(deps.selectTemplate).not.toHaveBeenCalled();
    expect(deps.postToThread).toHaveBeenCalledWith(
      "thread-1",
      expect.stringContaining("起動権限がありません"),
    );
  });

  it("stamps the owning subsidiary on the selected template invoke", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      run: { id: "run-sub", status: "queued" },
      spawn_pid: 44,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleForumSpawnThread(makeDeps({ subsidiaryId: "sub-1" }), makeThread());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ subsidiary_id: "sub-1" });
  });
});
