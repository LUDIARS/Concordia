import { describe, expect, it, vi } from "vitest";
import {
  buildForumSpawnIntakeQuestion,
  detectMissingForumSpawnInfo,
  dispatchForumSpawnIntakeInteraction,
  handleForumSpawnIntakeReply,
  isForumSpawnIntakeInteraction,
  MAX_ASK_COUNT,
  requestForumSpawnIntake,
  supplementForumSpawnBody,
  type ForumSpawnIntakeResumeDeps,
  type ForumSpawnIntakeStore,
} from "./forum-spawn-intake.js";

const log = () => ({ info: vi.fn(), warn: vi.fn() });

function requestDeps(store: ForumSpawnIntakeStore) {
  const postCard = vi.fn(async () => undefined);
  return { deps: { store, postCard, log: log() }, postCard };
}

function resumeDeps(store: ForumSpawnIntakeStore, overrides: Partial<ForumSpawnIntakeResumeDeps> = {}) {
  const resumeSpawn = vi.fn(async () => undefined);
  const reply = vi.fn(async () => undefined);
  const deps: ForumSpawnIntakeResumeDeps = {
    store,
    isLaunchUserAllowed: () => false,
    resumeSpawn,
    reply,
    log: log(),
    ...overrides,
  };
  return { deps, resumeSpawn, reply };
}

const baseRequest = {
  guildId: "g1",
  threadId: "thread-1",
  requesterUserId: "user-1",
  title: "直したい",
  body: "",
  missing: ["project", "task"] as const,
  projectChoices: ["Concordia", "Pictor"],
};

describe("不足情報の検出", () => {
  it("project 未解決と本文なしをそれぞれ拾う", () => {
    expect(detectMissingForumSpawnInfo({ body: "", projectResolved: false })).toEqual(["project", "task"]);
    expect(detectMissingForumSpawnInfo({ body: "直して", projectResolved: false })).toEqual(["project"]);
    expect(detectMissingForumSpawnInfo({ body: "   ", projectResolved: true })).toEqual(["task"]);
    expect(detectMissingForumSpawnInfo({ body: "直して", projectResolved: true })).toEqual([]);
  });
});

describe("質問カード", () => {
  it("候補があれば選択メニューを出し、thread id を customId に焼く", () => {
    const question = buildForumSpawnIntakeQuestion({
      requesterUserId: "user-1",
      missing: ["project"],
      projectChoices: ["Concordia"],
      threadId: "thread-1",
    });
    expect(question.components).toHaveLength(1);
    const json = question.components[0]!.toJSON() as { components: { custom_id: string }[] };
    expect(json.components[0]!.custom_id).toBe("forum-spawn-intake:project:thread-1");
    expect(question.content).toContain("関係プロジェクト");
  });

  it("候補が無ければ自由記述だけを求める", () => {
    const question = buildForumSpawnIntakeQuestion({
      requesterUserId: "user-1",
      missing: ["project", "task"],
      projectChoices: [],
      threadId: "thread-1",
    });
    expect(question.components).toHaveLength(0);
    expect(question.content).toContain("タスク内容");
    expect(question.content).toContain("返信");
  });

  it("候補が 25 件を超えたら切り詰めて、その旨を書く", () => {
    const question = buildForumSpawnIntakeQuestion({
      requesterUserId: "user-1",
      missing: ["project"],
      projectChoices: Array.from({ length: 30 }, (_, i) => `P${i}`),
      threadId: "thread-1",
    });
    const json = question.components[0]!.toJSON() as { components: { options: unknown[] }[] };
    expect(json.components[0]!.options).toHaveLength(25);
    expect(question.content).toContain("先頭 25 件");
  });
});

describe("質問の掲出", () => {
  it("質問を出して回答待ちに積む", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps, postCard } = requestDeps(store);
    await expect(requestForumSpawnIntake(deps, baseRequest)).resolves.toBe(true);
    expect(postCard).toHaveBeenCalledOnce();
    expect(store.get("thread-1")).toMatchObject({ requesterUserId: "user-1", askCount: 1 });
  });

  it("投稿に失敗したら保留を残さない (答えようのない待ちを作らない)", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const deps = {
      store,
      postCard: vi.fn(async () => { throw new Error("thread gone"); }),
      log: log(),
    };
    await expect(requestForumSpawnIntake(deps, baseRequest)).rejects.toThrow("thread gone");
    expect(store.has("thread-1")).toBe(false);
  });

  it("再質問の投稿失敗でも前回までの聞き返し回数は失わない", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps } = requestDeps(store);
    await requestForumSpawnIntake(deps, baseRequest);
    const previous = store.get("thread-1");
    deps.postCard.mockRejectedValueOnce(new Error("thread gone"));

    await expect(requestForumSpawnIntake(deps, baseRequest)).rejects.toThrow("thread gone");

    expect(store.get("thread-1")).toEqual(previous);
  });

  it(`同じスレッドでの聞き返しは ${MAX_ASK_COUNT} 回で打ち切る`, async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps, postCard } = requestDeps(store);
    for (let i = 0; i < MAX_ASK_COUNT; i += 1) {
      await expect(requestForumSpawnIntake(deps, baseRequest)).resolves.toBe(true);
    }
    await expect(requestForumSpawnIntake(deps, baseRequest)).resolves.toBe(false);
    expect(postCard).toHaveBeenCalledTimes(MAX_ASK_COUNT);
  });
});

describe("スレッド返信からの再開", () => {
  const reply = {
    guildId: "g1",
    channelId: "thread-1",
    messageId: "m1",
    authorId: "user-1",
    text: "Concordia の受付文言を直して",
  };

  async function pending(store: ForumSpawnIntakeStore, body = "") {
    const { deps } = requestDeps(store);
    await requestForumSpawnIntake(deps, { ...baseRequest, body });
  }

  it("依頼者の返信を本文へ足して spawn を再開する", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await pending(store, "元の本文");
    const { deps, resumeSpawn } = resumeDeps(store);

    await expect(handleForumSpawnIntakeReply(deps, reply)).resolves.toBe(true);

    expect(resumeSpawn).toHaveBeenCalledWith("thread-1", {
      title: "直したい",
      body: "元の本文\n\nConcordia の受付文言を直して",
    });
    // 行は消さず「回答済み」に倒す (聞き返し回数の持ち越しと二重取り込み防止)。
    expect(store.get("thread-1")).toMatchObject({ status: "answered", askCount: 1 });
  });

  it("スレッド本文 (starter message) は回答として取り込まない", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await pending(store);
    const { deps, resumeSpawn } = resumeDeps(store);

    // forum の starter message は message id が thread id と同じ。
    await expect(handleForumSpawnIntakeReply(deps, { ...reply, messageId: "thread-1" }))
      .resolves.toBe(false);
    expect(resumeSpawn).not.toHaveBeenCalled();
    expect(store.has("thread-1")).toBe(true);
  });

  it("回答して再開しても聞き返し回数を持ち越す (無限に聞き返さない)", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps: askDeps, postCard } = requestDeps(store);
    const { deps } = resumeDeps(store);

    // 「質問 → 回答 → まだ足りないので再質問」を上限まで繰り返す。
    for (let round = 0; round < MAX_ASK_COUNT; round += 1) {
      await expect(requestForumSpawnIntake(askDeps, baseRequest)).resolves.toBe(true);
      await expect(handleForumSpawnIntakeReply(deps, reply)).resolves.toBe(true);
    }
    await expect(requestForumSpawnIntake(askDeps, baseRequest)).resolves.toBe(false);
    expect(postCard).toHaveBeenCalledTimes(MAX_ASK_COUNT);
  });

  it("回答済みのスレッドへの追加投稿は回答として飲み込まない (起動後の inject を守る)", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await pending(store);
    const { deps, resumeSpawn } = resumeDeps(store);

    await expect(handleForumSpawnIntakeReply(deps, reply)).resolves.toBe(true);
    await expect(handleForumSpawnIntakeReply(deps, { ...reply, messageId: "m2" })).resolves.toBe(false);
    expect(resumeSpawn).toHaveBeenCalledOnce();
  });

  it("保留の無いスレッドには関与しない", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps, resumeSpawn } = resumeDeps(store);
    await expect(handleForumSpawnIntakeReply(deps, reply)).resolves.toBe(false);
    expect(resumeSpawn).not.toHaveBeenCalled();
  });

  it("別 guild の同名スレッド id では発火しない", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await pending(store);
    const { deps, resumeSpawn } = resumeDeps(store);
    await expect(handleForumSpawnIntakeReply(deps, { ...reply, guildId: "g2" })).resolves.toBe(false);
    expect(resumeSpawn).not.toHaveBeenCalled();
  });

  it("第三者の返信は起動の引き金にしない (spawn 権限が要る)", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await pending(store);
    const { deps, resumeSpawn } = resumeDeps(store);

    await expect(handleForumSpawnIntakeReply(deps, { ...reply, authorId: "someone-else" }))
      .resolves.toBe(false);
    expect(resumeSpawn).not.toHaveBeenCalled();
    expect(store.has("thread-1")).toBe(true);
  });

  it("spawn 権限のある社員の代理回答は受け付ける", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await pending(store);
    const { deps, resumeSpawn } = resumeDeps(store, { isLaunchUserAllowed: (id) => id === "manager" });

    await expect(handleForumSpawnIntakeReply(deps, { ...reply, authorId: "manager" })).resolves.toBe(true);
    expect(resumeSpawn).toHaveBeenCalledOnce();
  });

  it("再開が失敗したら内部エラーを漏らさずスレッドへ返す", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    await pending(store);
    const { deps, reply: threadReply } = resumeDeps(store, {
      resumeSpawn: vi.fn(async () => { throw new Error("thread not found"); }),
    });

    await expect(handleForumSpawnIntakeReply(deps, reply)).resolves.toBe(true);
    expect(threadReply).toHaveBeenCalledWith("thread-1", expect.stringContaining("Bot のログを確認"));
    expect(threadReply).not.toHaveBeenCalledWith("thread-1", expect.stringContaining("thread not found"));
  });
});

describe("選択メニューからの再開", () => {
  function makeSelect(values: string[], userId = "user-1") {
    const update = vi.fn(async () => undefined);
    const replyFn = vi.fn(async () => undefined);
    return {
      interaction: {
        customId: "forum-spawn-intake:project:thread-1",
        guildId: "g1",
        channelId: "thread-1",
        user: { id: userId },
        values,
        isStringSelectMenu: () => true,
        isRepliable: () => true,
        update,
        reply: replyFn,
      },
      update,
      replyFn,
    };
  }

  it("customId だけで面を判定する (型述語に依らない)", () => {
    expect(isForumSpawnIntakeInteraction({ customId: "forum-spawn-intake:project:t" } as never)).toBe(true);
    expect(isForumSpawnIntakeInteraction({ customId: "ctrl:spawn" } as never)).toBe(false);
    expect(isForumSpawnIntakeInteraction({} as never)).toBe(false);
  });

  it("選んだ project を本文へ足して再開する", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps: askDeps } = requestDeps(store);
    await requestForumSpawnIntake(askDeps, { ...baseRequest, body: "壊れている", missing: ["project"] });
    const { deps, resumeSpawn } = resumeDeps(store);
    const { interaction, update } = makeSelect(["Concordia"]);

    await dispatchForumSpawnIntakeInteraction(interaction as never, deps);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(resumeSpawn).toHaveBeenCalledWith("thread-1", {
      title: "直したい",
      body: "壊れている\n\n関係プロジェクト: Concordia",
    });
  });

  it("選んだ起動テンプレは本文へ足さず override として再開する", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps: askDeps } = requestDeps(store);
    await requestForumSpawnIntake(askDeps, {
      ...baseRequest,
      body: "壊れている",
      missing: ["template"],
      templateChoices: [{ callName: "forum-claude-session", label: "forum-claude-session (sonnet)" }],
    });
    const { deps, resumeSpawn } = resumeDeps(store);
    const { interaction, update } = makeSelect(["forum-claude-session"]);
    interaction.customId = "forum-spawn-intake:template:thread-1";

    await dispatchForumSpawnIntakeInteraction(interaction as never, deps);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    expect(resumeSpawn).toHaveBeenCalledWith("thread-1", {
      title: "直したい",
      body: "壊れている",
      template: "forum-claude-session",
    });
  });

  it("template 質問カードにはテンプレ選択メニューが付く", () => {
    const question = buildForumSpawnIntakeQuestion({
      requesterUserId: "user-1",
      missing: ["template"],
      projectChoices: [],
      templateChoices: [{ callName: "forum-claude-session", label: "forum-claude-session (sonnet)" }],
      threadId: "thread-1",
    });
    expect(question.content).toContain("起動テンプレ (モデル)");
    expect(question.components).toHaveLength(1);
  });

  it("別スレッドのカードからは再開しない", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps: askDeps } = requestDeps(store);
    await requestForumSpawnIntake(askDeps, baseRequest);
    const { deps, resumeSpawn } = resumeDeps(store);
    const { interaction, replyFn } = makeSelect(["Concordia"]);
    interaction.channelId = "other-thread";

    await dispatchForumSpawnIntakeInteraction(interaction as never, deps);

    expect(resumeSpawn).not.toHaveBeenCalled();
    expect(replyFn).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });

  it("権限の無い第三者の選択は拒否する", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps: askDeps } = requestDeps(store);
    await requestForumSpawnIntake(askDeps, baseRequest);
    const { deps, resumeSpawn } = resumeDeps(store);
    const { interaction, replyFn } = makeSelect(["Concordia"], "someone-else");

    await dispatchForumSpawnIntakeInteraction(interaction as never, deps);

    expect(resumeSpawn).not.toHaveBeenCalled();
    expect(replyFn).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(store.has("thread-1")).toBe(true);
  });

  it("失効した質問には失効を返す", async () => {
    const store: ForumSpawnIntakeStore = new Map();
    const { deps, resumeSpawn } = resumeDeps(store);
    const { interaction, replyFn } = makeSelect(["Concordia"]);

    await dispatchForumSpawnIntakeInteraction(interaction as never, deps);

    expect(resumeSpawn).not.toHaveBeenCalled();
    expect(replyFn).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});

describe("本文の補完", () => {
  it("空本文でも回答だけを本文にする", () => {
    expect(supplementForumSpawnBody("", ["関係プロジェクト: Concordia"]))
      .toBe("関係プロジェクト: Concordia");
  });

  it("空の追記は落とす", () => {
    expect(supplementForumSpawnBody("本文", ["  ", ""])).toBe("本文");
  });
});
