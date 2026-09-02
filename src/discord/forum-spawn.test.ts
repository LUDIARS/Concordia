import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import {
  buildForumSpawnPrompt,
  buildForumSpawnTrigger,
  executeForumSpawn,
  handleForumSpawnThread,
  isConcordiaSessionStarter,
  matchesApprovedForumContent,
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

  it("関係プロジェクトが取れない投稿は拒否ではなく質問にする (neco 指示 3)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const requestIntake = vi.fn(async () => true);
    const postToThread = vi.fn(async () => undefined);

    await handleForumSpawnThread(
      makeDeps({ resolveProjectTarget: () => null, requestIntake, postToThread }),
      makeThread(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({
      requesterUserId: "123456789",
      title: "[Cc] Implement Phase 2",
      missing: ["project"],
    }));
    expect(postToThread).not.toHaveBeenCalled();
  });

  it("本文が空なら タスク内容 も併せて聞く", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const requestIntake = vi.fn(async () => true);

    await handleForumSpawnThread(
      makeDeps({ resolveProjectTarget: () => null, requestIntake }),
      makeThread({ fetchStarterMessage: vi.fn(async () => ({ content: "   " })) }),
    );

    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["project", "task"] }));
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
      makeThread(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("関係プロジェクト"));
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
      makeThread(),
    );

    expect(postToThread).toHaveBeenCalledWith("thread-1", expect.stringContaining("関係プロジェクト"));
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

  it("承認済みの不完全な内容は回答で拡張せず再申請を求める", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const requestIntake = vi.fn(async () => true);
    const postToThread = vi.fn(async () => undefined);
    const thread = makeThread();

    await executeForumSpawn(
      makeDeps({ resolveProjectTarget: () => null, requestIntake, postToThread }),
      thread,
      {
        title: thread.name,
        body: "",
        tagState: { appliedTags: [], availableTags: [MANAGED_TAG] },
        approved: true,
      },
    );

    expect(requestIntake).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postToThread).toHaveBeenCalledWith(
      "thread-1",
      expect.stringContaining("新しいスレッドで依頼してください"),
    );
  });
});

describe("forum spawn: 承認は情報充足後 (2026-09-03 neco 指示)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("権限なし投稿者でも、関係プロジェクトが取れなければ承認より先に質問する", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const requestApproval = vi.fn(async () => undefined);
    const requestIntake = vi.fn(async () => true);
    const deps = makeDeps({
      isLaunchUserAllowed: () => false,
      resolveProjectTarget: () => null,
      requestApproval,
      requestIntake,
    });

    await handleForumSpawnThread(deps, makeThread({ ownerId: "human-denied" }));

    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({
      requesterUserId: "human-denied",
      missing: ["project"],
    }));
    expect(requestApproval).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.postToThread).not.toHaveBeenCalled();
  });

  it("権限なし投稿者はモデルも先に聞き、承認カードはまだ出さない", async () => {
    const requestApproval = vi.fn(async () => undefined);
    const requestIntake = vi.fn(async () => true);
    const deps = makeDeps({ isLaunchUserAllowed: () => false, requestApproval, requestIntake });

    await handleForumSpawnThread(deps, makeThread({ ownerId: "human-denied" }));

    expect(requestIntake).toHaveBeenCalledWith(expect.objectContaining({ missing: ["template"] }));
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("情報が揃った時点で確定内容のスナップショットを承認に回し、spawn はしない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const requestApproval = vi.fn(async () => undefined);
    const thread = makeThread({ ownerId: "human-denied" });
    const deps = makeDeps({
      isLaunchUserAllowed: () => false,
      resolveProjectTarget: () => null,
      requestApproval,
      requestIntake: vi.fn(async () => true),
    });

    const result = await executeForumSpawn(deps, thread, {
      title: thread.name,
      body: "Build spawn-by-post\n\n関係プロジェクト: Concordia",
      project: "Concordia",
      template: "forum-codex-session",
    });

    expect(result).toEqual({ ok: false, error: "approval requested" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledWith(thread, expect.objectContaining({
      title: thread.name,
      body: "Build spawn-by-post\n\n関係プロジェクト: Concordia",
      starterBody: "Build spawn-by-post",
      project: "Concordia",
      template: "forum-codex-session",
      tagState: { appliedTags: [], availableTags: [MANAGED_TAG] },
    }));
  });

  it("モデル/effort の回答も承認スナップショットへ固定する", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const requestApproval = vi.fn(async () => undefined);
    const fable = { ...template("fable-mid"), target_provider: "claude" as const, model: "claude-fable-5-1" };
    const thread = makeThread({ ownerId: "human-denied" });
    const deps = makeDeps({
      isLaunchUserAllowed: () => false,
      requestApproval,
      templates: vi.fn(async () => [fable]),
    });

    await executeForumSpawn(deps, thread, {
      title: thread.name,
      body: "Build spawn-by-post",
      model: "fable",
      effort: "xhigh",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestApproval).toHaveBeenCalledWith(thread, expect.objectContaining({
      project: "Concordia",
      model: "fable",
      effort: "xhigh",
    }));
  });

  it("承認ボタンからの再入 (approved) は権限確認を通らず、固定内容で起動する", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 12 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const requestApproval = vi.fn(async () => undefined);
    const thread = makeThread({ ownerId: "human-denied" });
    const deps = makeDeps({
      isLaunchUserAllowed: () => false,
      resolveProjectTarget: () => null,
      requestApproval,
    });

    const result = await executeForumSpawn(deps, thread, {
      title: thread.name,
      body: "Build spawn-by-post\n\n関係プロジェクト: Concordia",
      starterBody: "Build spawn-by-post",
      tagState: { appliedTags: [], availableTags: [MANAGED_TAG] },
      project: "Concordia",
      template: "forum-codex-session",
      approved: true,
    });

    expect(result).toEqual({ ok: true });
    expect(requestApproval).not.toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toMatchObject({ template: "forum-codex-session", project: "Concordia" });
    expect(body.prompt).toContain("関係プロジェクト: Concordia");
  });

  it("承認後の改変検知は starter 本文と突き合わせる (補完済み本文とは比較しない)", () => {
    const approved = {
      title: "t",
      body: "starter\n\n関係プロジェクト: Concordia",
      starterBody: "starter",
      tagState: { appliedTags: [], availableTags: [] },
      project: "Concordia",
    };
    expect(matchesApprovedForumContent("t", "starter", [], approved)).toBe(true);
    expect(matchesApprovedForumContent("t", "starter edited", [], approved)).toBe(false);
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
