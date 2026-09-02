import { describe, expect, it, vi } from "vitest";
import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import {
  executeForumSpawn,
  forumModelChoices,
  matchExplicitForumModel,
  normalizeForumEffort,
  type ForumSpawnDeps,
  type ForumSpawnThread,
} from "./forum-spawn.js";
import {
  buildForumSpawnModelQuestion,
  dispatchForumSpawnIntakeInteraction,
  requestForumSpawnIntake,
  type ForumSpawnIntakeResumeDeps,
  type ForumSpawnIntakeStore,
  type ForumSpawnModelChoice,
} from "./forum-spawn-intake.js";

// 2026-09-02 neco 指示: モデルは Fable/Opus/Sonnet/Sol/Terra、Effort も選ぶ
// (Test forum の provider・effort 選択と同型)。

function catalogTemplate(
  callName: string,
  provider: string,
  model: string | null,
  emoji = "",
): DelegationTemplateLite {
  return {
    call_name: callName,
    title: callName,
    description: "",
    target_provider: provider as DelegationTemplateLite["target_provider"],
    model,
    is_active: true,
    call_only: false,
    emoji,
    forum_tag: false,
    input_schema: [],
    default_cwd: null,
    project: null,
  };
}

const CATALOG: DelegationTemplateLite[] = [
  catalogTemplate("fable-mid", "claude", "claude-fable-5-1", "🦸"),
  catalogTemplate("fable-xhigh", "claude", "claude-fable-5-1", "🦸"),
  catalogTemplate("opus-mid", "claude", "claude-opus-5", "🧙‍♂️"),
  catalogTemplate("sonnet-mid", "claude", "claude-sonnet-5", "🧑‍💼"),
  catalogTemplate("sol-mid", "codex", "gpt-5.6-sol", "☀️"),
  catalogTemplate("terra-xhigh", "codex", "gpt-5.6-terra", "🌏"),
  catalogTemplate("design-hard-fable5", "claude", "claude-fable-5", "🧩"),
];

describe("forumModelChoices / normalizeForumEffort", () => {
  it("Fable/Opus/Sonnet/Sol/Terra を素のモデルテンプレから解決する", () => {
    const choices = forumModelChoices(CATALOG);
    expect(choices.map((c) => c.nick)).toEqual(["fable", "opus", "sonnet", "sol", "terra"]);
    const fable = choices.find((c) => c.nick === "fable")!;
    expect(fable).toMatchObject({
      provider: "claude",
      model: "claude-fable-5-1",
      emoji: "🦸",
      defaultEffort: "high",
    });
    expect(choices.find((c) => c.nick === "terra")).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-terra",
      defaultEffort: "xhigh",
    });
  });

  it("effort は provider の語彙へ正規化する", () => {
    expect(normalizeForumEffort("claude", undefined)).toBe("high");
    expect(normalizeForumEffort("codex", undefined)).toBe("xhigh");
    expect(normalizeForumEffort("claude", "minimal")).toBe("low");
    expect(normalizeForumEffort("codex", "minimal")).toBe("minimal");
    expect(normalizeForumEffort("claude", "invalid")).toBe("high");
  });

  it("投稿の明示はモデル nickname + effort を拾い、曖昧は null", () => {
    const choices = forumModelChoices(CATALOG);
    expect(matchExplicitForumModel("t", "fable xhigh でレビュー", choices)).toMatchObject({
      choice: { nick: "fable" },
      effort: "xhigh",
    });
    expect(matchExplicitForumModel("t", "terraで", choices)?.choice.nick).toBe("terra");
    expect(matchExplicitForumModel("t", "レビューして", choices)).toBeNull();
    expect(matchExplicitForumModel("t", "fable か opus で", choices)).toBeNull();
    expect(matchExplicitForumModel("t", "Resolve the console issue", choices)).toBeNull();
    expect(matchExplicitForumModel("t", "octopus を調べて", choices)).toBeNull();
    expect(matchExplicitForumModel("t", "gpt-5.6-solution を使う", choices)).toBeNull();
  });
});

describe("モデル/Effort 質問カード", () => {
  const MODEL_CHOICES: ForumSpawnModelChoice[] = [
    { nick: "fable", label: "Fable (claude-fable-5-1)", emoji: "🦸", defaultEffort: "high" },
    { nick: "sol", label: "Sol (gpt-5.6-sol)", emoji: "☀️", defaultEffort: "xhigh" },
  ];

  it("モデル select + Effort select + 起動ボタンの 3 行構成", () => {
    const card = buildForumSpawnModelQuestion({
      requesterUserId: "user-1",
      threadId: "thread-1",
      modelChoices: MODEL_CHOICES,
      chosenModel: "fable",
    });
    expect(card.content).toContain("選択中: 🦸 **Fable (claude-fable-5-1)** / effort: **high**");
    expect(card.components).toHaveLength(3);
    const rows = card.components.map(
      (row) => row.toJSON() as unknown as { components: Array<Record<string, unknown>> },
    );
    expect(rows[0]!.components[0]!.custom_id).toBe("forum-spawn-intake:model:thread-1");
    expect(rows[1]!.components[0]!.custom_id).toBe("forum-spawn-intake:effort:thread-1");
    expect(rows[2]!.components[0]!.custom_id).toBe("forum-spawn-intake:launch:thread-1");
    const modelOptions = (rows[0]!.components[0] as { options: Array<{ value: string; default?: boolean }> }).options;
    expect(modelOptions.find((option) => option.value === "fable")?.default).toBe(true);
  });

  function resumeDeps(store: ForumSpawnIntakeStore) {
    const resumeSpawn = vi.fn(async () => undefined);
    const deps: ForumSpawnIntakeResumeDeps = {
      store,
      isLaunchUserAllowed: () => false,
      resumeSpawn,
      reply: vi.fn(async () => undefined),
      log: { info: vi.fn(), warn: vi.fn() },
    };
    return { deps, resumeSpawn };
  }

  async function seedPending(store: ForumSpawnIntakeStore) {
    await requestForumSpawnIntake(
      { store, postCard: vi.fn(async () => undefined), log: { info: vi.fn(), warn: vi.fn() } },
      {
        guildId: "g1",
        threadId: "thread-1",
        requesterUserId: "user-1",
        title: "レビュー",
        body: "September を見て",
        missing: ["template"],
        projectChoices: [],
        modelChoices: MODEL_CHOICES,
      },
    );
  }

  function selectInteraction(kind: string, value: string, userId = "user-1") {
    const update = vi.fn(async () => undefined);
    const replyFn = vi.fn(async () => undefined);
    return {
      interaction: {
        customId: `forum-spawn-intake:${kind}:thread-1`,
        guildId: "g1",
        channelId: "thread-1",
        user: { id: userId },
        values: [value],
        update,
        reply: replyFn,
      },
      update,
      replyFn,
    };
  }

  function launchInteraction(userId = "user-1") {
    const update = vi.fn(async () => undefined);
    const replyFn = vi.fn(async () => undefined);
    return {
      interaction: {
        customId: "forum-spawn-intake:launch:thread-1",
        guildId: "g1",
        channelId: "thread-1",
        user: { id: userId },
        update,
        reply: replyFn,
      },
      update,
      replyFn,
    };
  }

  it("select は選択を保存してカードを描き替え、起動ボタンで確定する", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await seedPending(store);
    const { deps, resumeSpawn } = resumeDeps(store);

    const model = selectInteraction("model", "fable");
    await dispatchForumSpawnIntakeInteraction(model.interaction as never, deps);
    expect(resumeSpawn).not.toHaveBeenCalled();
    expect(store.get("thread-1")?.chosenModel).toBe("fable");
    expect(model.update).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Fable"),
    }));

    const effort = selectInteraction("effort", "xhigh");
    await dispatchForumSpawnIntakeInteraction(effort.interaction as never, deps);
    expect(store.get("thread-1")?.chosenEffort).toBe("xhigh");

    const launch = launchInteraction();
    await dispatchForumSpawnIntakeInteraction(launch.interaction as never, deps);
    expect(resumeSpawn).toHaveBeenCalledWith("thread-1", {
      title: "レビュー",
      body: "September を見て",
      model: "fable",
      effort: "xhigh",
    });
    expect(store.get("thread-1")?.status).toBe("answered");
  });

  it("モデル未選択の起動ボタンは ephemeral で促すだけ", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await seedPending(store);
    const { deps, resumeSpawn } = resumeDeps(store);

    const launch = launchInteraction();
    await dispatchForumSpawnIntakeInteraction(launch.interaction as never, deps);
    expect(resumeSpawn).not.toHaveBeenCalled();
    expect(launch.replyFn).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(store.get("thread-1")?.status).toBe("waiting");
  });

  it("カードに無いモデルや effort は受理しない", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await seedPending(store);
    const { deps, resumeSpawn } = resumeDeps(store);

    const invalidModel = selectInteraction("model", "unknown-model");
    await dispatchForumSpawnIntakeInteraction(invalidModel.interaction as never, deps);
    expect(invalidModel.replyFn).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(store.get("thread-1")?.chosenModel).toBeUndefined();

    const invalidEffort = selectInteraction("effort", "unlimited");
    await dispatchForumSpawnIntakeInteraction(invalidEffort.interaction as never, deps);
    expect(invalidEffort.replyFn).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(store.get("thread-1")?.chosenEffort).toBeUndefined();
    expect(resumeSpawn).not.toHaveBeenCalled();
  });

  it("起動ボタンは外部 update の前に回答済みへ遷移する", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await seedPending(store);
    store.set("thread-1", { ...store.get("thread-1")!, chosenModel: "fable" });
    const { deps } = resumeDeps(store);
    let statusDuringUpdate: string | undefined;
    const launch = launchInteraction();
    launch.interaction.update = vi.fn(async () => {
      statusDuringUpdate = store.get("thread-1")?.status;
    });

    await dispatchForumSpawnIntakeInteraction(launch.interaction as never, deps);
    expect(statusDuringUpdate).toBe("answered");
  });
});

describe("executeForumSpawn model override", () => {
  function makeThread(patch: Partial<ForumSpawnThread> = {}): ForumSpawnThread {
    return {
      id: "thread-1",
      guildId: "guild-1",
      parentId: "forum-1",
      ownerId: "123456789",
      name: "レビュー",
      appliedTags: [],
      availableTags: [],
      fetchStarterMessage: vi.fn(async () => ({ content: "September を見て" })),
      fetchTagState: vi.fn(async () => ({ appliedTags: [], availableTags: [] })),
      ...patch,
    };
  }

  function makeDeps(patch: Partial<ForumSpawnDeps> = {}): ForumSpawnDeps {
    return {
      sessionForumId: "forum-1",
      botUserId: "987654321",
      concordiaUrl: "http://concordia.test",
      isLaunchUserAllowed: (userId) => userId === "123456789",
      templates: vi.fn(async () => CATALOG),
      selectTemplate: vi.fn(async () => ({ ok: false as const, error: "unused" })),
      resolveProjectTarget: () => ({ project: "September", code: "Sep", cwd: "E:/Document/Ars/September" }),
      hasExistingRun: () => false,
      postToThread: vi.fn(async () => undefined),
      renameThread: vi.fn(async () => undefined),
      log: { info: vi.fn(), warn: vi.fn() },
      ...patch,
    };
  }

  it("model 回答は provider+model+effort の素 spawn になる (テンプレ不使用)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 7 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const deps = makeDeps();
      const result = await executeForumSpawn(deps, makeThread(), {
        title: "レビュー",
        body: "September を見て",
        model: "fable",
        effort: "xhigh",
      });
      expect(result).toEqual({ ok: true });
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(body).toMatchObject({
        provider: "claude",
        model: "claude-fable-5-1",
        options: { effort: "xhigh" },
        project: "September",
      });
      expect(body.template).toBeUndefined();
      expect(deps.postToThread).toHaveBeenCalledWith(
        "thread-1",
        expect.stringContaining("🦸 Cc がセッションを起動しました"),
      );
      // モデル確定でスレッド名にモデル絵文字を前置する (2026-09-02 neco 指示)。
      expect(deps.renameThread).toHaveBeenCalledWith("thread-1", "🦸 レビュー");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("codex 系は model_reasoning_effort、claude の minimal は low へ丸める", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 8 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await executeForumSpawn(makeDeps(), makeThread(), {
        title: "t",
        body: "b",
        model: "terra",
        effort: "minimal",
      });
      const codexBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(codexBody.options).toEqual({ model_reasoning_effort: "minimal" });

      await executeForumSpawn(makeDeps(), makeThread({ id: "thread-2" }), {
        title: "t",
        body: "b",
        model: "opus",
        effort: "minimal",
      });
      const claudeBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1].body);
      expect(claudeBody.options).toEqual({ effort: "low" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("投稿にモデル明示があれば質問なしで起動する", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, pid: 9 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const requestIntake = vi.fn(async () => true);
      const deps = makeDeps({ requestIntake });
      const thread = makeThread({
        fetchStarterMessage: vi.fn(async () => ({ content: "sol xhigh で September を見て" })),
      });
      const result = await executeForumSpawn(deps, thread);
      expect(result).toEqual({ ok: true });
      expect(requestIntake).not.toHaveBeenCalled();
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(body).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", options: { model_reasoning_effort: "xhigh" } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
