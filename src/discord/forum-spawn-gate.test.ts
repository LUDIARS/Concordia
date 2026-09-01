import { describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import {
  executeForumSpawn,
  handleForumSpawnThread,
  matchesApprovedForumContent,
  type ForumSpawnDeps,
  type ForumSpawnThread,
} from "./forum-spawn.js";

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
    input_schema: [],
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
    availableTags: [],
    fetchStarterMessage: vi.fn(async () => ({ content: "Build spawn-by-post" })),
    fetchTagState: vi.fn(async () => ({ appliedTags: [], availableTags: [] })),
    ...patch,
  };
}

function makeDeps(patch: Partial<ForumSpawnDeps> = {}): ForumSpawnDeps {
  const selected = template();
  return {
    sessionForumId: "forum-1",
    botUserId: "987654321",
    concordiaUrl: "http://concordia.test",
    isLaunchUserAllowed: (userId) => userId === "123456789",
    templates: vi.fn(async () => [selected]),
    selectTemplate: vi.fn(async () => ({ ok: true as const, template: selected })),
    resolveProjectTarget: () => ({ project: "Cc", code: "Cc", cwd: "C:/work/Concordia" }),
    resolveSpawnCwd: (_provider, requested) => requested,
    hasExistingRun: () => false,
    postToThread: vi.fn(async () => undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...patch,
  };
}

describe("forum spawn approval + guard wiring", () => {
  it("requests an approval card instead of a flat deny when wired", async () => {
    const requestApproval = vi.fn(async () => undefined);
    const deps = makeDeps({ isLaunchUserAllowed: () => false, requestApproval });
    const thread = makeThread();
    await handleForumSpawnThread(deps, thread);
    expect(requestApproval).toHaveBeenCalledWith(thread, {
      title: "[Cc] Implement Phase 2",
      body: "Build spawn-by-post",
      tagState: { appliedTags: [], availableTags: [] },
    });
    expect(deps.postToThread).not.toHaveBeenCalled();
    expect(deps.templates).not.toHaveBeenCalled();
  });

  it("falls back to the flat deny reply when approval is unwired", async () => {
    const deps = makeDeps({ isLaunchUserAllowed: () => false });
    await handleForumSpawnThread(deps, makeThread());
    expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("起動権限"));
  });

  it("stops before template selection when the subsidiary guard denies", async () => {
    const deps = makeDeps({
      guardInstruction: vi.fn(async () => ({ ok: false, replyText: "⛔ 受け付けられません: スコープ外" })),
    });
    const result = await executeForumSpawn(deps, makeThread());
    expect(result).toEqual({ ok: false, error: "subsidiary guard denied the request" });
    expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("受け付けられません"));
    expect(deps.selectTemplate).not.toHaveBeenCalled();
  });

  it("posts the advisory note to the thread and still spawns", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, run: { id: "run-adv", status: "spawned" }, spawn_pid: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps({
        guardInstruction: vi.fn(async () => ({
          ok: true,
          replyText: "",
          advisoryText: "⚠️ ガード所見 (advisory): スコープ外の懸念",
        })),
      });
      const result = await executeForumSpawn(deps, makeThread());
      expect(result).toEqual({ ok: true });
      expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("ガード所見"));
      expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("Cc がセッションを起動しました"));
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("proceeds to spawn when the guard allows", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, run: { id: "run-1", status: "spawned" }, spawn_pid: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps({
        guardInstruction: vi.fn(async () => ({ ok: true, replyText: "" })),
      });
      const result = await executeForumSpawn(deps, makeThread());
      expect(result).toEqual({ ok: true });
      expect(deps.selectTemplate).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a recorded spawn failure instead of claiming that the session launched", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        run: { id: "run-failed", status: "spawn_failed" },
        spawn_pid: null,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps();
      const result = await executeForumSpawn(deps, makeThread());

      expect(result).toEqual({ ok: false, error: "delegation spawn failed" });
      expect(deps.postToThread).toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining("プロセスを起動できませんでした"),
      );
      expect(deps.postToThread).not.toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining("Cc がセッションを起動しました"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects approval content after the title or starter body changes", () => {
    const approved = {
      title: "[Cc] Implement Phase 2",
      body: "Build spawn-by-post",
      tagState: { appliedTags: ["rule-1"], availableTags: [] },
    };
    expect(matchesApprovedForumContent(approved.title, approved.body, ["rule-1"], approved)).toBe(true);
    expect(matchesApprovedForumContent("[Cc] Different project", approved.body, ["rule-1"], approved)).toBe(false);
    expect(matchesApprovedForumContent(approved.title, "Run a different task", ["rule-1"], approved)).toBe(false);
    expect(matchesApprovedForumContent(approved.title, approved.body, ["rule-2"], approved)).toBe(false);
  });
});
