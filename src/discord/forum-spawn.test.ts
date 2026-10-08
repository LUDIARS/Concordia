import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import {
  buildForumSpawnPrompt,
  buildForumSpawnTrigger,
  executeForumSpawn,
  handleForumSpawnThread,
  isConcordiaSessionStarter,
  parseForumSpawnTrigger,
  type ForumSpawnDeps,
  type ForumSpawnThread,
} from "./forum-spawn.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";

const MANAGED_TAG = { id: "managed-tag", name: CONCORDIA_MANAGED_FORUM_TAG_NAME };

describe("discussion type before Cc intake", () => {
  it("retains the guard after improvement is selected", async () => {
    const guardInstruction = vi.fn(async () => ({ ok: false as const, replyText: "guard denied" }));
    const deps = makeDeps({ guardInstruction });
    const thread = makeThread({ fetchTagState: vi.fn(async () => ({ appliedTags: ["i"], availableTags: [{ id: "i", name: "改善/議論" }] })) });
    expect(await executeForumSpawn(deps, thread)).toEqual({ ok: false, error: "subsidiary guard denied the request" });
    expect(guardInstruction).toHaveBeenCalledOnce();
  });
  it.each([{ appliedTags: [] }, { appliedTags: ["planning"] }])("does not guard, ask for a project or spawn for $appliedTags", async ({ appliedTags }) => {
    const guardInstruction = vi.fn();
    const resolveProjectTarget = vi.fn(() => null);
    const deps = makeDeps({ guardInstruction, resolveProjectTarget });
    const thread = makeThread({ fetchTagState: vi.fn(async () => ({ appliedTags, availableTags: [{ id: "planning", name: "企画/議論" }, { id: "improvement", name: "改善/議論" }] })) });
    const result = await executeForumSpawn(deps, thread);
    expect(result.ok).toBe(false);
    expect(guardInstruction).not.toHaveBeenCalled();
    expect(resolveProjectTarget).not.toHaveBeenCalled();
    expect(deps.postToThread).not.toHaveBeenCalled();
    expect(deps.selectTemplate).not.toHaveBeenCalled();
  });
});

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
    resolveProjectTarget: () => ({ project: "Concordia", code: "Cc", cwd: "E:/Document/Ars/Concordia" }),
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

  it("hands a site-tagged post to the site instead of spawning on HQ", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const routeRemoteSpawn = vi.fn(() => ({ siteName: "HASTER" }));
    const selectTemplate = vi.fn();
    const deps = makeDeps({ routeRemoteSpawn, selectTemplate });
    const thread = makeThread({ appliedTags: ["site-tag"], availableTags: [MANAGED_TAG, { id: "site-tag", name: "HASTER" }] });
    await expect(executeForumSpawn(deps, thread)).resolves.toEqual({ ok: true });
    expect(routeRemoteSpawn).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild-1", channelId: "thread-1", authorId: "123456789",
      title: "[Cc] Implement Phase 2", body: "Build spawn-by-post", appliedTagNames: ["HASTER"],
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(selectTemplate).not.toHaveBeenCalled();
    expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("HASTER"));
  });

  describe("project-assigned sites (SPEC-FED-SPAWN-SITE, 2026-10-07)", () => {
    const routeOk = () => vi.fn(() => ({ ok: true as const, siteId: "melpot", siteName: "MELPOT" }));

    it("hands the post to the only site assigned to the resolved project", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const route = routeOk();
      const deps = makeDeps({ spawnSites: { forProject: () => [{ siteId: "melpot", name: "MELPOT" }], route } });
      await expect(executeForumSpawn(deps, makeThread())).resolves.toEqual({ ok: true });
      expect(route).toHaveBeenCalledWith(expect.objectContaining({
        site: "melpot", channelId: "thread-1", title: "[Cc] Implement Phase 2", body: "Build spawn-by-post", options: { project: "Concordia" },
      }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("MELPOT"));
    });

    it("asks for the target when several sites are assigned, then follows the answer", async () => {
      const requestIntake = vi.fn(async () => true);
      const route = routeOk();
      const candidates = [{ siteId: "melpot", name: "MELPOT" }, { siteId: "gromac", name: "GROMAC" }];
      const deps = makeDeps({ requestIntake, spawnSites: { forProject: () => candidates, route } });
      await expect(executeForumSpawn(deps, makeThread())).resolves.toEqual({ ok: false, error: "site selection requested" });
      expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["site"], siteChoices: candidates }));
      expect(route).not.toHaveBeenCalled();
      await expect(executeForumSpawn(deps, makeThread(), { title: "[Cc] Implement Phase 2", body: "Build spawn-by-post", site: "gromac" }))
        .resolves.toEqual({ ok: true });
      expect(route).toHaveBeenCalledWith(expect.objectContaining({ site: "gromac" }));
    });

    it("spawns on HQ when HQ is chosen or no site is assigned", async () => {
      const route = routeOk();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 1 }), { status: 200 })));
      const chooseHq = makeDeps({ spawnSites: { forProject: () => [{ siteId: "melpot", name: "MELPOT" }], route } });
      await executeForumSpawn(chooseHq, makeThread(), { title: "[Cc] Implement Phase 2", body: "Build spawn-by-post", site: "__hq__" });
      const unassigned = makeDeps({ spawnSites: { forProject: () => [], route } });
      await executeForumSpawn(unassigned, makeThread());
      expect(route).not.toHaveBeenCalled();
    });

    it("does not silently spawn on HQ when the assigned site cannot be reached", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const route = vi.fn(() => ({ ok: false as const, reason: "listener_unavailable" as const }));
      const deps = makeDeps({ spawnSites: { forProject: () => [{ siteId: "melpot", name: "MELPOT" }], route } });
      await expect(executeForumSpawn(deps, makeThread())).resolves.toEqual({ ok: false, error: "site route failed: listener_unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deps.postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("listener"));
    });

    it("keeps department forums on their own launch path", async () => {
      const route = routeOk();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 1 }), { status: 200 })));
      const deps = makeDeps({
        department: { id: "dept", name: "AI総合", projects: [], hasLaunchDefault: true } as unknown as ForumSpawnDeps["department"],
        spawnSites: { forProject: () => [{ siteId: "melpot", name: "MELPOT" }], route },
      });
      await executeForumSpawn(deps, makeThread());
      expect(route).not.toHaveBeenCalled();
    });
  });

  it("spawns on HQ as before when no site is selected", async () => {
    const routeRemoteSpawn = vi.fn(() => null);
    const deps = makeDeps({ routeRemoteSpawn });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 1 }), { status: 200 })));
    await executeForumSpawn(deps, makeThread());
    expect(routeRemoteSpawn).toHaveBeenCalledTimes(1);
    expect(deps.postToThread).not.toHaveBeenCalledWith("thread-1", expect.stringContaining("拠点"));
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

  it("selects one active template and spawns a plain session with the post as startup prompt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      pid: 42,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const selected = template("impl-from-forum");
    const deps = makeDeps({
      templates: async () => [selected],
      selectTemplate: vi.fn(async () => ({ ok: true as const, template: selected })),
    });

    await handleForumSpawnThread(deps, makeThread());

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/admin/spawn-session");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // delegation invoke の「実装タスク」ラッパーではなく /spawn と同じ素の spawn +
    // startup inject (2026-09-02 neco 指示: Inject は spawn のものと同一)。
    expect(body).toMatchObject({
      template: "impl-from-forum",
      inject_prompt: false,
      subsidiary_id: null,
      project: "Concordia",
      requester_discord_user_id: "123456789",
      source_discord_guild_id: "guild-1",
      source_discord_channel_id: "thread-1",
    });
    expect(String(body.prompt)).toContain("Build spawn-by-post");
    expect(body).not.toHaveProperty("cwd");
  });

  it("モデル別絵文字を起動完了メッセージに表示する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      pid: 42,
    }), { status: 200 })));
    const selected = {
      ...template("forum-claude-session"),
      model: "claude-fable-5-1",
      emoji: "🟣",
    };
    const modelTemplate = {
      ...template("fable-mid"),
      model: "claude-fable-5",
      emoji: "🦸",
      forum_tag: false,
    };
    const postToThread = vi.fn(async () => undefined);

    const result = await executeForumSpawn(
      makeDeps({ templates: async () => [selected, modelTemplate], postToThread }),
      makeThread(),
      {
        title: "[Cc] Implement Phase 2",
        body: "Build spawn-by-post",
        template: selected.call_name,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(postToThread).toHaveBeenCalledWith(
      "thread-1",
      expect.stringMatching(/^🦸 Cc がセッションを起動しました/),
    );
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
      pid: 46,
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
    expect(JSON.parse(String(init.body)).prompt).toContain("Active rules: Webサービス");
  });

  it("asks for the template (or gives up in plain text) when selection fails", async () => {
    // 質問面 (requestIntake) が未配線なら、何が足りないかを平文で伝えて終わる
    // (無言で捨てない)。 配線済みの質問経路は forum-spawn-gate.test.ts が見る。
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
    expect(deps.postToThread).toHaveBeenCalledWith(
      "thread-1",
      expect.stringContaining("起動テンプレ (モデル)を特定できない"),
    );
  });

  it("does not reflect an unavailable supplied template into Discord", async () => {
    const suppliedTemplate = "missing-template\n@everyone";
    const deps = makeDeps();

    const result = await executeForumSpawn(deps, makeThread(), {
      title: "[Cc] Implement Phase 2",
      body: "Build spawn-by-post",
      template: suppliedTemplate,
    });

    expect(result).toEqual({ ok: false, error: "supplied template unavailable" });
    expect(deps.postToThread).toHaveBeenCalledWith(
      "thread-1",
      "選択された起動テンプレは利用できません。もう一度選択してください。",
    );
    expect(deps.postToThread).not.toHaveBeenCalledWith(
      "thread-1",
      expect.stringContaining(suppliedTemplate),
    );
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
    await handleForumSpawnThread(
      makeDeps({ subsidiaryId: "sub-1", resolveSubsidiaryProjects: () => ["Concordia"] }),
      makeThread(),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ subsidiary_id: "sub-1" });
  });

  it("子会社の関係プロジェクト外なら起動しない (spec §3.4)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const replies: string[] = [];
    const warn = vi.fn();
    const postToThread = async (_threadId: string, content: string) => { replies.push(content); };
    await handleForumSpawnThread(
      makeDeps({
        subsidiaryId: "sub-1",
        resolveSubsidiaryProjects: () => ["Pagus\nforged=true"],
        postToThread,
        log: { info: vi.fn(), warn },
      }),
      makeThread(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replies.join(" ")).toContain("担当範囲外");
    expect(replies.join(" ")).not.toContain("Concordia");
    expect(replies.join(" ")).not.toContain("Pagus");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("\n");
  });

  it("関係プロジェクト未設定の子会社も起動しない", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleForumSpawnThread(
      makeDeps({ subsidiaryId: "sub-1", resolveSubsidiaryProjects: () => [] }),
      makeThread(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("関係プロジェクト resolver 未配線の子会社も fail-closed", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const postToThread = vi.fn(async () => undefined);
    await handleForumSpawnThread(makeDeps({ subsidiaryId: "sub-1", postToThread }), makeThread());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("設定を確認できない"));
  });

  it("本社 Bot (resolveSubsidiaryProjects 無し) は従来どおり起動する", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      run: { id: "run-ho", status: "queued" },
      spawn_pid: 45,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await handleForumSpawnThread(makeDeps(), makeThread());
    expect(fetchMock).toHaveBeenCalled();
  });

  it("関係プロジェクトが取れない本社の投稿は聞き返さずプロジェクト無しで起動する (2026-10-07 neco 指示)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const requestIntake = vi.fn(async () => true);

    await handleForumSpawnThread(
      makeDeps({ resolveProjectTarget: () => null, requestIntake }),
      makeThread(),
    );

    expect(requestIntake).not.toHaveBeenCalledWith(expect.objectContaining({
      missing: expect.arrayContaining(["project"]),
    }));
  });

  it("本文が空なら タスク内容 だけを聞く (関係プロジェクトは聞かない)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const requestIntake = vi.fn(async () => true);

    await handleForumSpawnThread(
      makeDeps({ resolveProjectTarget: () => null, requestIntake }),
      makeThread({ fetchStarterMessage: vi.fn(async () => ({ content: "   " })) }),
    );

    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["task"] }));
  });

  it("本文が空でも project が取れるなら タスク内容 だけ聞く", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const requestIntake = vi.fn(async () => true);

    await handleForumSpawnThread(
      makeDeps({ requestIntake }),
      makeThread({ fetchStarterMessage: vi.fn(async () => ({ content: "" })) }),
    );

    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["task"] }));
  });

  it("聞き返しを出せなければ何が足りないかを平文で伝える (無言で捨てない)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const postToThread = vi.fn(async () => undefined);

    await handleForumSpawnThread(
      makeDeps({
        resolveProjectTarget: () => null,
        requestIntake: vi.fn(async () => false),
        postToThread,
      }),
      makeThread({ fetchStarterMessage: vi.fn(async () => ({ content: "   " })) }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("タスク内容"));
  });

  it("質問カードの投稿が失敗しても不足を平文で返す", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const postToThread = vi.fn(async () => undefined);

    await handleForumSpawnThread(
      makeDeps({
        resolveProjectTarget: () => null,
        requestIntake: vi.fn(async () => { throw new Error("component post failed at private endpoint"); }),
        postToThread,
      }),
      makeThread({ fetchStarterMessage: vi.fn(async () => ({ content: "   " })) }),
    );

    expect(postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("タスク内容"));
  });

  it("回答で補完した本文を渡すと起動まで進む", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      run: { id: "run-intake", status: "queued" },
      spawn_pid: 11,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const requestIntake = vi.fn(async () => true);
    const thread = makeThread({ fetchStarterMessage: vi.fn(async () => ({ content: "" })) });

    await executeForumSpawn(
      makeDeps({ requestIntake }),
      thread,
      // テンプレは明示 (明示なしは質問になる)。
      { title: thread.name, body: "関係プロジェクト: Concordia\n\n受付文言を直して (forum-codex-session)" },
    );

    expect(requestIntake).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    // タグ状態を渡していないので実行時に取り直す (回答中の付け替えを取りこぼさない)。
    expect(thread.fetchTagState).toHaveBeenCalled();
    // 補完した本文を starter から読み直さない。
    expect(thread.fetchStarterMessage).not.toHaveBeenCalled();
  });

});

describe("forum spawn: 起動の承認なし (2026-10-03 neco 指示)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("名簿の判定で起動できる投稿者は承認を待たずにそのまま起動する", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 12 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    // session_spawn はヒラ社員から通る (roles.ts)。 未登録の投稿者も判定器は true を返す。
    const deps = makeDeps({ isLaunchUserAllowed: () => true });

    await handleForumSpawnThread(deps, makeThread({ ownerId: "unregistered-staff" }));

    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("/v1/admin/spawn-session");
    expect(deps.postToThread).not.toHaveBeenCalledWith("thread-1", expect.stringContaining("承認"));
  });

  it("会社のセッション上限で断られたら、その理由をスレッドへ返す", async () => {
    const reason = "本社のセッション上限 (30) に達しています。動いているセッションが終わってから起動してください。";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: `session_cap_reached: ${reason}` }),
      { status: 429 },
    )));
    const deps = makeDeps({ isLaunchUserAllowed: () => true });

    const result = await executeForumSpawn(deps, makeThread());

    expect(result).toEqual({ ok: false, error: "session cap reached" });
    expect(deps.postToThread).toHaveBeenCalledWith("thread-1", reason);
  });
});

describe("matchExplicitForumTemplate", () => {
  const codex = template("forum-codex-session");
  const sonnet = { ...template("forum-claude-session"), model: "claude-sonnet-5" };

  it("call_name か model トークンの明示だけを 1 件一致で採用する", async () => {
    const { matchExplicitForumTemplate } = await import("./forum-spawn.js");
    expect(matchExplicitForumTemplate("t", "forum-claude-session で", [codex, sonnet])?.call_name)
      .toBe("forum-claude-session");
    expect(matchExplicitForumTemplate("t", "sonnet でお願い", [codex, sonnet])?.call_name)
      .toBe("forum-claude-session");
    // 明示なし → null (質問へ)。
    expect(matchExplicitForumTemplate("t", "レビューして", [codex, sonnet])).toBeNull();
    // "claude" は一般語なのでテンプレ指定と読まない。
    expect(matchExplicitForumTemplate("t", "Claude Code で直して", [codex, sonnet])).toBeNull();
    expect(matchExplicitForumTemplate("t", "GPT でレビューして", [codex, sonnet])).toBeNull();
    // 短いモデル名を通常の単語の部分文字列から誤検出しない。
    expect(matchExplicitForumTemplate("t", "Resolve the console issue", [codex, sonnet])).toBeNull();
    // call_name も、より長い別識別子の一部なら明示と読まない。
    expect(matchExplicitForumTemplate("t", "forum-codex-session-extra で", [codex])).toBeNull();
  });

  it("複数一致 (曖昧) と inactive / forum_tag 無しは採用しない", async () => {
    const { matchExplicitForumTemplate } = await import("./forum-spawn.js");
    const sonnet2 = { ...sonnet, call_name: "forum-claude-heavy" };
    expect(matchExplicitForumTemplate("t", "sonnet で", [sonnet, sonnet2])).toBeNull();
    expect(matchExplicitForumTemplate("t", "sonnet で", [{ ...sonnet, is_active: false }])).toBeNull();
    expect(matchExplicitForumTemplate("t", "sonnet で", [{ ...sonnet, forum_tag: false }])).toBeNull();
  });
});

describe("modelEmojiFromTemplates", () => {
  const t = (callName: string, model: string | null, emoji: string) => ({
    ...template(callName),
    model,
    emoji,
  });
  const catalog = [
    t("fable-mid", "claude-fable-5", "🦸"),
    t("fable-xhigh", "claude-fable-5", "🦸"),
    t("opus-mid", "claude-opus-5", "🧙‍♂️"),
    t("sol-mid", "gpt-5.6-sol", "☀️"),
    t("sonnet-mid", "claude-sonnet-5", "🧑‍💼"),
    t("haiku", "claude-haiku-4-5-20251001", "🗣️"),
    t("claude-sonnet-5-walk", "claude-sonnet-5", "🚶"),
    t("design-hard-fable5", "claude-fable-5", "🧩"),
  ];

  it("モデル id のトークンから素のモデルテンプレの絵文字を引く", async () => {
    const { modelEmojiFromTemplates } = await import("./forum-spawn.js");
    expect(modelEmojiFromTemplates("claude-fable-5-1", catalog)).toBe("🦸");
    expect(modelEmojiFromTemplates("claude-opus-5", catalog)).toBe("🧙‍♂️");
    expect(modelEmojiFromTemplates("gpt-5.6-sol", catalog)).toBe("☀️");
    // sonnet は task 用 (claude-sonnet-5-walk 🚶) でなく sonnet-mid を優先する。
    expect(modelEmojiFromTemplates("claude-sonnet-5", catalog)).toBe("🧑‍💼");
    // call_name 完全一致 (haiku) が最優先。
    expect(modelEmojiFromTemplates("claude-haiku-4-5-20251001", catalog)).toBe("🗣️");
  });

  it("引けないモデルは null (呼び出し側でテンプレ絵文字へフォールバック)", async () => {
    const { modelEmojiFromTemplates } = await import("./forum-spawn.js");
    expect(modelEmojiFromTemplates("auto", catalog)).toBeNull();
    expect(modelEmojiFromTemplates(null, catalog)).toBeNull();
    expect(modelEmojiFromTemplates("claude-unknown-9", catalog)).toBeNull();
  });
});
