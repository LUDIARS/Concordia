import { ChannelType, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import {
  createTestForumDiscordAdapter,
  mergedMessage,
  renderTestForumControls,
  starterContent,
  statusChangeMessage,
} from "./test-forum-discord.js";
import type { TestForumCandidate } from "./test-forum-reconcile.js";

function detail(overrides: Partial<RevisorLocalPrDetail> = {}): RevisorLocalPrDetail {
  return {
    author: "neco",
    headRef: "feat/forum",
    baseRef: "main",
    body: null,
    decisionState: "needs_human",
    decisionLabel: "人間の判断が必要",
    blockers: ["動作確認が必要"],
    riskScore: 57,
    riskThreshold: 30,
    riskBandLabel: "high",
    runtimeVerificationRequired: true,
    testsPassed: 3,
    testsRan: 4,
    failedTests: [],
    reviewError: null,
    securityStatus: "passed",
    mergeable: true,
    autoMerge: { merged: false, reason: "閾値超過" },
    ...overrides,
  };
}

function candidate(overrides: Partial<TestForumCandidate> = {}): TestForumCandidate {
  return {
    repoOrigin: "LUDIARS/Concordia",
    prNumber: 42,
    pullRequestId: "local-pr-42",
    title: "Test Forum",
    url: null,
    headBranch: "feat/forum",
    headSha: "sha-1",
    repoRootPath: "E:/Document/Ars/Concordia",
    worktreePath: null,
    checkStatus: "test_ok",
    sessionId: null,
    mentionUserIds: [],
    detail: detail(),
    contentHash: "hash-1",
    ...overrides,
  };
}

describe("starterContent", () => {
  it("renders the decision summary and blockers", () => {
    const content = starterContent(candidate());
    expect(content).toContain("**判定** 人間の判断が必要");
    expect(content).toContain("**マージリスク** 57 (high) / 閾値 30");
    expect(content).toContain("**テスト** 3/4 passed");
    expect(content).toContain("**セキュリティスキャン** passed");
    expect(content).toContain("**動作確認** 人間による動作確認が必要");
    expect(content).toContain("**オートマージ** 見送り — 閾値超過");
    expect(content).toContain("**マージ可否** マージOK");
    expect(content).toContain("- 動作確認が必要");
  });

  it("falls back to the skeleton when the detail is unavailable", () => {
    const content = starterContent(candidate({ detail: null }));
    expect(content).toContain("**Repo** `LUDIARS/Concordia`");
    expect(content).toContain("**Head** `feat/forum` @ `sha-1`");
    expect(content).not.toContain("**判定**");
  });

  it("includes failure evidence when the check status is failed", () => {
    const content = starterContent(candidate({
      checkStatus: "failed",
      detail: detail({
        decisionState: "needs_human",
        failedTests: [{
          name: "unit",
          exitCode: 1,
          reason: "assertion failed",
          output: { text: "not ok 4", truncated: false },
        }],
      }),
    }));

    expect(content).toContain("**失敗したテスト**");
    expect(content).toContain("unit (exit 1)");
    expect(content).toContain("not ok 4");
  });

  it("redacts credentials from failure evidence before posting to Discord", () => {
    const content = starterContent(candidate({
      checkStatus: "failed",
      detail: detail({
        reviewError: "Bearer never-post-this token=also-never-post-this",
      }),
    }));

    expect(content).toContain("Bearer [REDACTED]");
    expect(content).not.toContain("never-post-this");
    expect(content).not.toContain("also-never-post-this");
  });

  it("stays within the Discord message limit even for a huge PR", () => {
    const content = starterContent(candidate({
      detail: detail({
        blockers: Array.from({ length: 40 }, (_, i) => `${i}: ${"長い判断事項".repeat(60)}`),
        body: "本文".repeat(2000),
      }),
    }));
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it("never cuts a surrogate pair in half", () => {
    // 壊れた文字 (lone surrogate) を含む content は Discord に 400 で弾かれる。
    const content = starterContent(candidate({
      detail: detail({ blockers: [`${"あ".repeat(179)}🧪 tail`] }),
    }));
    expect(content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(content).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("statusChangeMessage", () => {
  it("tells the thread what the review concluded", () => {
    const passed = statusChangeMessage(candidate({ checkStatus: "test_ok" }));
    expect(passed).toContain("審査を通過");
    expect(passed).toContain("テスト開始OK");
    expect(passed).toContain("マージOK");
    expect(statusChangeMessage(candidate({ checkStatus: "failed" }))).toContain("動作確認が必要");
    const actionRequired = statusChangeMessage(candidate({ checkStatus: "action_required" }));
    expect(actionRequired).toContain("人間の判断が必要");
    expect(actionRequired).toContain("> 動作確認が必要");

    const draft = statusChangeMessage(candidate({
      checkStatus: "test_ok",
      detail: detail({ mergeable: false }),
    }));
    expect(draft).toContain("マージ保留");
    expect(draft).not.toContain("マージOK");

    const unavailable = statusChangeMessage(candidate({ detail: null }));
    expect(unavailable).toContain("マージ保留");
    expect(unavailable).not.toContain("マージOK");
  });

  it("posts concrete action_required failures with test output instead of calling them a human decision", () => {
    const content = statusChangeMessage(candidate({
      checkStatus: "action_required",
      detail: detail({
        decisionState: "failed",
        decisionLabel: "審査が失敗",
        blockers: ["1 registered test case(s) failed"],
        failedTests: [{
          name: "unit",
          exitCode: 1,
          reason: null,
          output: { text: "not ok 4", truncated: false },
        }],
      }),
    }));
    expect(content).toContain("審査に失敗");
    expect(content).toContain("unit (exit 1)");
    expect(content).toContain("not ok 4");
    expect(content).not.toContain("人間の判断が必要です");
  });

  it("survives a candidate with no detail", () => {
    expect(statusChangeMessage(candidate({ checkStatus: "failed", detail: null }))).toContain("審査に失敗");
    expect(statusChangeMessage(candidate({ checkStatus: "action_required", detail: null }))).toContain("判断が必要");
  });
});

describe("mergedMessage", () => {
  it("records the merge and its commit before the thread is closed", () => {
    const message = mergedMessage({
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      status: "merged",
      mergeCommitSha: "a".repeat(40),
    });
    expect(message).toContain("マージしました");
    expect(message).toContain("統合コミット");
  });

  it("does not interpolate a malformed commit value into Discord Markdown", () => {
    const message = mergedMessage({
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      status: "merged",
      mergeCommitSha: `${"a".repeat(2_000)}\n@everyone`,
    });
    expect(message).toContain("マージしました");
    expect(message).not.toContain("統合コミット");
    expect(message).not.toContain("@everyone");
    expect(message.length).toBeLessThanOrEqual(2_000);
  });
});

function fakeThread(archived = false) {
  const starter = { edit: vi.fn(async (_payload: { allowedMentions?: unknown }) => undefined) };
  const controls = { edit: vi.fn(async (_payload: unknown) => undefined) };
  const thread = {
    id: "thread-42",
    type: ChannelType.PublicThread,
    name: "[Concordia #42] Test Forum",
    archived,
    setArchived: vi.fn(async (value: boolean, _reason?: string) => {
      thread.archived = value;
    }),
    setName: vi.fn(async (_name: string, _reason?: string) => undefined),
    fetchStarterMessage: vi.fn(async () => starter),
    messages: { fetch: vi.fn(async () => controls) },
    send: vi.fn(async (_payload: unknown) => ({ id: "controls-1" })),
  };
  return { thread, starter, controls };
}

function guildWith(thread: ReturnType<typeof fakeThread>["thread"]): Guild {
  return {
    channels: { cache: new Map([[thread.id, thread]]), fetch: vi.fn(async () => null) },
  } as unknown as Guild;
}

function surfaceRow(overrides: Partial<DiscordTestSurfaceRow> = {}): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: "sha-0",
    repo_root_path: "E:/Document/Ars/Concordia",
    head_branch: "feat/forum",
    worktree_path: null,
    thread_id: "thread-42",
    status: "open",
    created_at: 1,
    closed_at: null,
    close_reason: null,
    content_hash: "hash-0",
    qa_run_id: null,
    run_state: "candidate",
    provider: "codex",
    model: "sol",
    effort: "xhigh",
    session_id: null,
    local_pr_id: null,
    controls_message_id: null,
    check_status: null,
    ...overrides,
  };
}

describe("createTestForumDiscordAdapter", () => {
  it("suppresses mentions so PR text cannot ping the guild", async () => {
    const create = vi.fn(async (_options: { message: { allowedMentions?: unknown } }) => (
      { id: "thread-99" }
    ));
    const guild = {
      channels: {
        cache: new Map([["forum-1", { type: ChannelType.GuildForum, threads: { create } }]]),
      },
    } as unknown as Guild;

    await createTestForumDiscordAdapter(guild, "forum-1")
      .create(candidate({ title: "@everyone please look" }));

    expect(create.mock.calls[0][0].message.allowedMentions).toEqual({ parse: [] });
  });

  it("pings the submitting session's operators in a separate message", async () => {
    const send = vi.fn(async (_payload: unknown) => ({ id: "ping-1" }));
    const create = vi.fn(async (_options: unknown) => ({ id: "thread-99", send }));
    const guild = {
      channels: {
        cache: new Map([["forum-1", { type: ChannelType.GuildForum, threads: { create } }]]),
      },
    } as unknown as Guild;

    await createTestForumDiscordAdapter(guild, "forum-1")
      .create(candidate({ mentionUserIds: ["111", "222"], checkStatus: "queued" }));

    const payload = send.mock.calls[0][0] as { content: string; allowedMentions: unknown };
    expect(payload.content).toContain("<@111> <@222>");
    expect(payload.content).toContain("審査待ち");
    // starter と違い、 この 1 通だけは指名した相手を実際に ping する。
    expect(payload.allowedMentions).toEqual({ users: ["111", "222"] });
  });

  it("keeps the post when the mention message cannot be sent", async () => {
    // ここで throw すると DB 行が作られず、 次周期が同じ PR の投稿を二重に立てる。
    const send = vi.fn(async () => { throw new Error("missing permissions"); });
    const create = vi.fn(async (_options: unknown) => ({ id: "thread-99", send }));
    const guild = {
      channels: {
        cache: new Map([["forum-1", { type: ChannelType.GuildForum, threads: { create } }]]),
      },
    } as unknown as Guild;

    await expect(
      createTestForumDiscordAdapter(guild, "forum-1").create(candidate({ mentionUserIds: ["111"] })),
    ).resolves.toEqual({ threadId: "thread-99" });
  });

  it("announces a status change as a plain thread message", async () => {
    const { thread } = fakeThread();
    await createTestForumDiscordAdapter(guildWith(thread), "forum-1")
      .postStatusChange(surfaceRow(), candidate({ checkStatus: "failed" }));
    const payload = thread.send.mock.calls[0][0] as { content: string; allowedMentions: unknown };
    expect(payload.content).toContain("審査に失敗");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("posts the merge result before the thread is archived", async () => {
    const { thread } = fakeThread(true);
    const adapter = createTestForumDiscordAdapter(guildWith(thread), "forum-1");
    await adapter.postMerged(surfaceRow(), {
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      status: "merged",
      mergeCommitSha: "a".repeat(40),
    });
    expect(thread.setArchived).toHaveBeenCalledWith(false, expect.any(String));
    const payload = thread.send.mock.calls[0][0] as { content: string; allowedMentions: unknown };
    expect(payload.content).toContain("マージしました");
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("treats a deleted thread as already closed so session cleanup can continue", async () => {
    const guild = {
      channels: { cache: new Map(), fetch: vi.fn(async () => null) },
    } as unknown as Guild;
    await expect(createTestForumDiscordAdapter(guild, "forum-1").postMerged(surfaceRow(), {
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      status: "merged",
      mergeCommitSha: "a".repeat(40),
    })).resolves.toBeUndefined();
  });

  it("treats Discord Unknown Channel as already closed", async () => {
    const guild = {
      channels: {
        cache: new Map(),
        fetch: vi.fn(async () => {
          throw Object.assign(new Error("Unknown Channel"), { code: 10_003 });
        }),
      },
    } as unknown as Guild;
    await expect(createTestForumDiscordAdapter(guild, "forum-1").postMerged(surfaceRow(), {
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      status: "merged",
      mergeCommitSha: "a".repeat(40),
    })).resolves.toBeUndefined();
  });

  it("propagates transient thread lookup failures so reconciliation can retry", async () => {
    const guild = {
      channels: {
        cache: new Map(),
        fetch: vi.fn(async () => {
          throw new Error("temporarily unavailable");
        }),
      },
    } as unknown as Guild;
    await expect(createTestForumDiscordAdapter(guild, "forum-1").postMerged(surfaceRow(), {
      repoOrigin: "LUDIARS/Concordia",
      prNumber: 42,
      status: "merged",
      mergeCommitSha: "a".repeat(40),
    })).rejects.toThrow("temporarily unavailable");
  });

  it("un-archives before posting a settled status", async () => {
    const { thread } = fakeThread(true);
    await createTestForumDiscordAdapter(guildWith(thread), "forum-1")
      .postStatusChange(surfaceRow(), candidate({ checkStatus: "failed" }));

    expect(thread.setArchived).toHaveBeenCalledWith(false, expect.any(String));
    expect(thread.setArchived.mock.invocationCallOrder[0])
      .toBeLessThan(thread.send.mock.invocationCallOrder[0]);
  });

  it("un-archives before editing a still-listed post", async () => {
    const { thread, starter } = fakeThread(true);
    const adapter = createTestForumDiscordAdapter(guildWith(thread), "forum-1");

    await adapter.update(surfaceRow(), candidate({ title: "renamed" }));

    // archive 中の thread は編集も rename も拒否されるので、 解除が先でなければならない。
    expect(thread.setArchived).toHaveBeenCalledWith(false, expect.any(String));
    expect(thread.setArchived.mock.invocationCallOrder[0])
      .toBeLessThan(starter.edit.mock.invocationCallOrder[0]);
    expect(starter.edit.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
    expect(thread.setName).toHaveBeenCalledWith("[Concordia #42] renamed", expect.any(String));
  });

  it("un-archives before posting the controls onto an idle thread", async () => {
    // 操作面の後付け (controls backfill) は放置で archive された古い投稿にこそ効く。
    // archive 中の thread は send も拒否されるので、 解除が先でなければならない。
    const { thread } = fakeThread(true);
    const rendered = await createTestForumDiscordAdapter(guildWith(thread), "forum-1")
      .render!(surfaceRow());
    expect(thread.setArchived).toHaveBeenCalledWith(false, expect.any(String));
    expect(thread.setArchived.mock.invocationCallOrder[0])
      .toBeLessThan(thread.send.mock.invocationCallOrder[0]);
    expect(rendered).toEqual({ controlsMessageId: "controls-1" });
  });

  it("removes existing controls when the candidate is no longer actionable", async () => {
    const { thread, controls } = fakeThread();
    await createTestForumDiscordAdapter(guildWith(thread), "forum-1")
      .clearControls!(surfaceRow({ controls_message_id: "controls-1" }));

    expect(controls.edit).toHaveBeenCalledWith({
      content: "この候補の操作面は現在利用できません。",
      components: [],
    });
  });

  it("archives on close and leaves an already-archived thread alone", async () => {
    const open = fakeThread().thread;
    await createTestForumDiscordAdapter(guildWith(open), "forum-1")
      .close(surfaceRow(), "candidate-unavailable");
    expect(open.setArchived).toHaveBeenCalledWith(true, expect.stringContaining("candidate-unavailable"));

    const alreadyClosed = fakeThread(true).thread;
    await createTestForumDiscordAdapter(guildWith(alreadyClosed), "forum-1")
      .close(surfaceRow(), "candidate-unavailable");
    expect(alreadyClosed.setArchived).not.toHaveBeenCalled();
  });
});

const controlSurface: DiscordTestSurfaceRow = {
  id: 17, scope: "", repo_origin: "LUDIARS/Concordia", pr_number: 8, head_sha: "abc",
  repo_root_path: "E:/Document/Ars/Concordia", head_branch: "feat/pr-8",
  worktree_path: "E:/wt", thread_id: "thread", status: "open" as const, created_at: 1,
  closed_at: null, close_reason: null, provider: "codex" as const, model: "sol",
  effort: "xhigh" as const, session_id: null, local_pr_id: null, controls_message_id: null,
  content_hash: null, qa_run_id: null, run_state: "candidate", check_status: "test_ok",
};

describe("renderTestForumControls", () => {
  it("renders candidate selectors and start button from the persisted config", () => {
    const rendered = renderTestForumControls({ ...controlSurface, run_state: "candidate" });
    expect(rendered.content).toContain("codex/sol");
    expect(rendered.components).toHaveLength(3);
    expect((rendered.components[2]?.components[0]?.data as { custom_id?: string }).custom_id).toBe("test:start:17");
  });

  it("replaces selectors with merge and removes every control after merge", () => {
    expect(renderTestForumControls({ ...controlSurface, run_state: "testing" }).components).toHaveLength(1);
    const starting = renderTestForumControls({ ...controlSurface, run_state: "starting" });
    expect(starting.components).toEqual([]);
    expect(starting.content).toContain("起動しています");
    expect(renderTestForumControls({ ...controlSurface, run_state: "merged" }).components).toEqual([]);
  });
});
