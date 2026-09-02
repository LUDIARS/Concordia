import { describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import {
  createGuardAdvisoryPostClaims,
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
      starterBody: "Build spawn-by-post",
      tagState: { appliedTags: [], availableTags: [] },
      project: "Cc",
      template: "forum-codex-session",
    });
    expect(deps.postToThread).not.toHaveBeenCalled();
    expect(deps.templates).toHaveBeenCalledOnce();
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

  it("posts the advisory note once per thread and still spawns", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps({
        guardInstruction: vi.fn(async () => ({
          ok: true,
          replyText: "",
          advisoryText: "advisory note",
        })),
        guardAdvisoryPostClaims: createGuardAdvisoryPostClaims(),
        hasExistingRun: () => false,
      });
      expect(await executeForumSpawn(deps, makeThread())).toEqual({ ok: true });
      expect(await executeForumSpawn(deps, makeThread())).toEqual({ ok: true });
      const advisoryPosts = (deps.postToThread as ReturnType<typeof vi.fn>).mock.calls
        .filter(([, content]) => String(content).includes("advisory note"));
      expect(advisoryPosts).toHaveLength(1);
      expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("Cc がセッションを起動しました"));
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries the advisory note after posting it fails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      let advisoryAttempts = 0;
      const deps = makeDeps({
        guardInstruction: vi.fn(async () => ({
          ok: true,
          replyText: "",
          advisoryText: "advisory note",
        })),
        guardAdvisoryPostClaims: createGuardAdvisoryPostClaims(),
        postToThread: vi.fn(async (_threadId: string, content: string) => {
          if (content === "advisory note" && advisoryAttempts++ === 0) {
            throw new Error("temporary Discord failure");
          }
        }),
      });

      expect(await executeForumSpawn(deps, makeThread())).toEqual({ ok: true });
      expect(await executeForumSpawn(deps, makeThread())).toEqual({ ok: true });
      expect(await executeForumSpawn(deps, makeThread())).toEqual({ ok: true });
      expect(advisoryAttempts).toBe(2);
      expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("advisory note post failed"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("proceeds to spawn via /v1/admin/spawn-session when the guard allows", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps({
        guardInstruction: vi.fn(async () => ({ ok: true, replyText: "" })),
      });
      const result = await executeForumSpawn(deps, makeThread());
      expect(result).toEqual({ ok: true });
      expect(deps.selectTemplate).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://concordia.test/v1/admin/spawn-session",
        expect.objectContaining({ method: "POST" }),
      );
      // 素の spawn + startup inject (inject_prompt=false)。 delegation invoke の
      // 「実装タスク」ラッパーを通さない (2026-09-02 neco 指示)。
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(body).toMatchObject({
        template: "forum-codex-session",
        inject_prompt: false,
        project: "Cc",
        source_discord_channel_id: "thread-1",
      });
      expect(body.prompt).toContain("Build spawn-by-post");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a spawn failure instead of claiming that the session launched", async () => {
    const internalError = "backend detail that must stay internal\nsecond diagnostic line";
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: internalError }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps();
      const result = await executeForumSpawn(deps, makeThread());

      expect(result).toEqual({ ok: false, error: "session spawn failed" });
      expect(deps.postToThread).toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining("セッション起動に失敗しました"),
      );
      expect(deps.postToThread).not.toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining(internalError),
      );
      expect(deps.postToThread).not.toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining("Cc がセッションを起動しました"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks for the launch template instead of a flat deny when the selector fails", async () => {
    const deps = makeDeps({
      selectTemplate: vi.fn(async () => ({ ok: false as const, error: "選択失敗" })),
    });
    const result = await executeForumSpawn(deps, makeThread());
    expect(result).toEqual({ ok: false, error: "template selection requested" });
    expect(deps.selectTemplate).toHaveBeenCalledOnce();
    expect(deps.postToThread).toHaveBeenCalledWith(
      "thread-1",
      expect.stringContaining("起動テンプレ (モデル)を特定できない"),
    );
  });

  it("asks for the template when the post does not name one, without running the selector", async () => {
    // モデル (テンプレ) は明示が無ければ人間に選んでもらう (2026-09-02 neco 指示)。
    const requestIntake = vi.fn(async () => true);
    const deps = makeDeps({ requestIntake });
    const result = await executeForumSpawn(deps, makeThread());
    expect(result).toEqual({ ok: false, error: "template selection requested" });
    expect(deps.selectTemplate).not.toHaveBeenCalled();
    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["template"] }));
  });

  it("spawns directly when the post names the template or its model token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 9 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const requestIntake = vi.fn(async () => true);
      const deps = makeDeps({
        requestIntake,
        templates: vi.fn(async () => [template("forum-codex-session")]),
      });
      const thread = makeThread({
        fetchStarterMessage: vi.fn(async () => ({ content: "sol でレビューして" })),
      });
      const result = await executeForumSpawn(deps, thread);
      expect(result).toEqual({ ok: true });
      expect(requestIntake).not.toHaveBeenCalled();
      expect(deps.selectTemplate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses a supplied project override even when the registry cannot resolve it", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 3 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps({
        resolveProjectTarget: () => null,
        resolveSubsidiaryProjects: () => ["AlphaProject", "BetaProject"],
        subsidiaryId: "sub-1",
      });
      const result = await executeForumSpawn(deps, makeThread(), {
        title: "レビューしたい",
        body: "コードレビューをする\n\n関係プロジェクト: AlphaProject",
        project: "AlphaProject",
      });
      expect(result).toEqual({ ok: true });
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(body.project).toBe("AlphaProject");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves a subsidiary project mentioned in the post text without the registry", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 4 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const requestIntake = vi.fn(async () => true);
      const deps = makeDeps({
        resolveProjectTarget: () => null,
        resolveSubsidiaryProjects: () => ["Alpha", "Alpha-Project"],
        subsidiaryId: "sub-1",
        requestIntake,
      });
      const thread = makeThread({
        name: "レビュー",
        fetchStarterMessage: vi.fn(async () => ({ content: "Alpha-Projectのコードレビューをする (forum-codex-session)" })),
      });
      const result = await executeForumSpawn(deps, thread);
      expect(result).toEqual({ ok: true });
      expect(requestIntake).not.toHaveBeenCalled();
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(body.project).toBe("Alpha-Project");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not infer a subsidiary project from a substring inside another word", async () => {
    const requestIntake = vi.fn(async () => true);
    const deps = makeDeps({
      resolveProjectTarget: () => null,
      resolveSubsidiaryProjects: () => ["AI"],
      subsidiaryId: "sub-1",
      requestIntake,
    });
    const thread = makeThread({
      name: "Maintain the review flow",
      fetchStarterMessage: vi.fn(async () => ({ content: "Fix the review routing" })),
    });

    const result = await executeForumSpawn(deps, thread);

    expect(result).toEqual({ ok: false, error: "missing information requested" });
    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["project"] }));
  });

  it("uses a supplied template from the intake answer without re-running the selector", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 2 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps();
      const result = await executeForumSpawn(deps, makeThread(), {
        title: "[Cc] Implement Phase 2",
        body: "Build spawn-by-post",
        template: "forum-codex-session",
      });
      expect(result).toEqual({ ok: true });
      expect(deps.selectTemplate).not.toHaveBeenCalled();
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(body.template).toBe("forum-codex-session");
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
