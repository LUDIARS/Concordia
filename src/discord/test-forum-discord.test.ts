import { ChannelType, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import { createTestForumDiscordAdapter, starterContent } from "./test-forum-discord.js";
import type { TestForumCandidate } from "./test-forum-reconcile.js";

function detail(overrides: Partial<RevisorLocalPrDetail> = {}): RevisorLocalPrDetail {
  return {
    author: "neco",
    headRef: "feat/forum",
    baseRef: "main",
    body: null,
    decisionLabel: "人間の判断が必要",
    blockers: ["動作確認が必要"],
    riskScore: 57,
    riskThreshold: 30,
    riskBandLabel: "high",
    runtimeVerificationRequired: true,
    testsPassed: 3,
    testsRan: 4,
    securityStatus: "passed",
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
    worktreePath: null,
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
    expect(content).toContain("- 動作確認が必要");
  });

  it("falls back to the skeleton when the detail is unavailable", () => {
    const content = starterContent(candidate({ detail: null, headBranch: null }));
    expect(content).toContain("**Repo** `LUDIARS/Concordia`");
    expect(content).toContain("**Head** `-` @ `sha-1`");
    expect(content).not.toContain("**判定**");
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

function fakeThread(archived = false) {
  const starter = { edit: vi.fn(async (_payload: { allowedMentions?: unknown }) => undefined) };
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
  };
  return { thread, starter };
}

function guildWith(thread: ReturnType<typeof fakeThread>["thread"]): Guild {
  return {
    channels: { cache: new Map([[thread.id, thread]]), fetch: vi.fn(async () => null) },
  } as unknown as Guild;
}

function surfaceRow(): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: "sha-0",
    worktree_path: null,
    thread_id: "thread-42",
    status: "open",
    created_at: 1,
    closed_at: null,
    close_reason: null,
    content_hash: "hash-0",
    qa_run_id: null,
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
