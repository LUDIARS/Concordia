import { describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrDetail, RevisorOpenLocalPr } from "../pr/revisor-test-workflow-client.js";
import {
  buildTestForumCandidates,
  reconcileTestForum,
  type TestForumCandidate,
  type TestForumQaHooks,
  type TestForumSurfaceAdapter,
} from "./test-forum-reconcile.js";

function detail(overrides: Partial<RevisorLocalPrDetail> = {}): RevisorLocalPrDetail {
  return {
    author: "neco",
    headRef: "feat/forum",
    baseRef: "main",
    body: null,
    decisionLabel: "自動マージ可",
    blockers: [],
    riskScore: 12,
    riskThreshold: 30,
    riskBandLabel: "low",
    runtimeVerificationRequired: false,
    testsPassed: 3,
    testsRan: 3,
    securityStatus: "passed",
    autoMerge: null,
    ...overrides,
  };
}

function openPr(overrides: Partial<RevisorOpenLocalPr> = {}): RevisorOpenLocalPr {
  return {
    id: "local-pr-42",
    repository: "LUDIARS/Concordia",
    number: 42,
    title: "Test Forum",
    headRef: "feat/test-forum",
    headSha: "sha-head",
    reviewedHeadSha: "sha-1",
    repositoryRootPath: "E:/Document/Ars/Concordia",
    checkStatus: "test_ok",
    sessionId: "sess-1",
    detail: detail(),
    ...overrides,
  };
}

function candidate(overrides: Partial<RevisorOpenLocalPr> = {}): TestForumCandidate {
  return buildTestForumCandidates([openPr(overrides)])[0];
}

function surface(overrides: Partial<DiscordTestSurfaceRow> = {}): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: "sha-1",
    repo_root_path: "E:/Document/Ars/Concordia",
    head_branch: "feat/test-forum",
    worktree_path: null,
    thread_id: "thread-old",
    status: "open",
    created_at: 1,
    closed_at: null,
    close_reason: null,
    content_hash: null,
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

function harness(open: DiscordTestSurfaceRow[] = []) {
  const rows = [...open];
  const surfaces: DiscordTestSurfacesRepo = {
    listOpen: vi.fn(() => rows.filter((row) => row.status === "open")),
    create: vi.fn((input) => {
      const row = surface({
        id: rows.length + 10,
        head_sha: input.headSha,
        repo_root_path: input.repoRootPath,
        head_branch: input.headBranch,
        thread_id: input.threadId,
        worktree_path: input.worktreePath,
        content_hash: input.contentHash,
        check_status: input.checkStatus,
      });
      rows.push(row);
      return row;
    }),
    updateContent: vi.fn((id, input) => {
      const row = rows.find((entry) => entry.id === id);
      if (row) {
        row.head_sha = input.headSha;
        row.content_hash = input.contentHash;
        row.check_status = input.checkStatus;
      }
    }),
    setQaRun: vi.fn((id, qaRunId) => {
      const row = rows.find((entry) => entry.id === id);
      if (row) row.qa_run_id = qaRunId;
    }),
    close: vi.fn((id, reason) => {
      const row = rows.find((entry) => entry.id === id);
      if (row) {
        row.status = "closed";
        row.close_reason = reason;
      }
    }),
    findOpen: vi.fn(() => null),
    updateRunConfig: vi.fn(),
    markTesting: vi.fn(),
    setLocalPrId: vi.fn(),
    markMerged: vi.fn(),
    setControlsMessageId: vi.fn(),
  };
  const adapter: TestForumSurfaceAdapter = {
    create: vi.fn(async () => ({ threadId: `thread-${rows.length + 1}` })),
    update: vi.fn(async () => undefined),
    render: vi.fn(async (row) => ({ controlsMessageId: `controls-${row.id}` })),
    postStatusChange: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const qa: TestForumQaHooks = {
    start: vi.fn(async () => "run-qa-1"),
    end: vi.fn(async () => undefined),
  };
  return { surfaces, adapter, qa, rows };
}

describe("buildTestForumCandidates", () => {
  it("projects every open local PR (any check status) with its detail and mentions", () => {
    const mentions = new Map([["sess-1", ["111", "222"]]]);
    const [built] = buildTestForumCandidates([openPr({ checkStatus: "failed" })], mentions);
    expect(built.repoOrigin).toBe("LUDIARS/Concordia");
    expect(built.prNumber).toBe(42);
    expect(built.checkStatus).toBe("failed");
    expect(built.headBranch).toBe("feat/test-forum");
    expect(built.detail?.decisionLabel).toBe("自動マージ可");
    expect(built.mentionUserIds).toEqual(["111", "222"]);
    expect(built.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the raw head when the PR has not been reviewed yet", () => {
    const [built] = buildTestForumCandidates([openPr({ reviewedHeadSha: null, checkStatus: "queued" })]);
    expect(built.headSha).toBe("sha-head");
  });

  it("changes the content hash when the check status changes, and ignores mentions", () => {
    const a = buildTestForumCandidates([openPr()], new Map([["sess-1", ["111"]]]))[0];
    const b = buildTestForumCandidates([openPr()], new Map())[0];
    const c = buildTestForumCandidates([openPr({ checkStatus: "failed" })])[0];
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });
});

describe("reconcileTestForum", () => {
  it("creates one surface for a newly registered PR without starting a QA session", async () => {
    const h = harness();
    const built = candidate({ checkStatus: "queued" });
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result).toEqual({ scanned: 0, kept: 0, updated: 0, created: 1, closed: 0, failed: 0 });
    expect(h.surfaces.create).toHaveBeenCalledWith(expect.objectContaining({
      contentHash: built.contentHash,
      checkStatus: "queued",
      repoRootPath: "E:/Document/Ars/Concordia",
      headBranch: "feat/test-forum",
    }));
    // テストセッションの起動点はボタン / スレッド投稿。 掲載だけでは起動しない。
    expect(h.qa.start).not.toHaveBeenCalled();
    // 審査前の候補には操作面 (テスト開始/マージ) を出さない。
    expect(h.adapter.render).not.toHaveBeenCalled();
  });

  it("attaches the control message only to a Test OK candidate", async () => {
    const h = harness();
    await reconcileTestForum({ candidates: [candidate({ checkStatus: "test_ok" })], ...h });
    expect(h.surfaces.setControlsMessageId).toHaveBeenCalledWith(10, "controls-10");
  });

  it("closes a surface and ends its QA session when the PR leaves the open list", async () => {
    const h = harness([surface({ qa_run_id: "run-qa-9" })]);
    const result = await reconcileTestForum({ candidates: [], ...h });
    expect(result.closed).toBe(1);
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "candidate-unavailable");
    expect(h.qa.end).toHaveBeenCalledWith(expect.objectContaining({ qa_run_id: "run-qa-9" }));
    expect(h.adapter.create).not.toHaveBeenCalled();
  });

  it("refreshes a changed post by editing and announces a review pass", async () => {
    const stale = candidate({ checkStatus: "running" });
    const h = harness([surface({ content_hash: stale.contentHash, check_status: "running", controls_message_id: "c-1" })]);
    const fresh = candidate({ checkStatus: "test_ok" });
    const result = await reconcileTestForum({ candidates: [fresh], ...h });
    expect(result).toEqual({ scanned: 1, kept: 1, updated: 1, created: 0, closed: 0, failed: 0 });
    expect(h.adapter.update).toHaveBeenCalledWith(expect.anything(), fresh);
    // 審査の決着 (running → test_ok) はスレッドへ通常メッセージで知らせる。
    expect(h.adapter.postStatusChange).toHaveBeenCalledWith(expect.anything(), fresh);
    expect(h.surfaces.updateContent).toHaveBeenCalledWith(7, {
      headSha: "sha-1",
      contentHash: fresh.contentHash,
      checkStatus: "test_ok",
    });
    expect(h.adapter.close).not.toHaveBeenCalled();
    expect(h.qa.start).not.toHaveBeenCalled();
  });

  it("announces a review failure but not a queued/running churn", async () => {
    const queued = candidate({ checkStatus: "queued" });
    const h = harness([surface({ content_hash: queued.contentHash, check_status: "queued" })]);
    await reconcileTestForum({ candidates: [candidate({ checkStatus: "running" })], ...h });
    expect(h.adapter.postStatusChange).not.toHaveBeenCalled();

    const running = candidate({ checkStatus: "running" });
    const h2 = harness([surface({ content_hash: running.contentHash, check_status: "running" })]);
    const failed = candidate({ checkStatus: "failed" });
    await reconcileTestForum({ candidates: [failed], ...h2 });
    expect(h2.adapter.postStatusChange).toHaveBeenCalledWith(expect.anything(), failed);
  });

  it("leaves an unchanged post alone (no Discord edit)", async () => {
    const built = candidate();
    const h = harness([surface({ content_hash: built.contentHash, check_status: "test_ok", controls_message_id: "c-1" })]);
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result).toEqual({ scanned: 1, kept: 1, updated: 0, created: 0, closed: 0, failed: 0 });
    expect(h.adapter.update).not.toHaveBeenCalled();
  });

  it("backfills controls onto Test OK surfaces posted before the controls existed", async () => {
    const built = candidate();
    const h = harness([surface({ content_hash: built.contentHash, check_status: "test_ok" })]);
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result).toEqual({ scanned: 1, kept: 1, updated: 0, created: 0, closed: 0, failed: 0 });
    expect(h.surfaces.setControlsMessageId).toHaveBeenCalledWith(7, "controls-7");
  });

  it("keeps reconciling when a kept thread can no longer be rendered", async () => {
    const built = candidate();
    const h = harness([surface({ content_hash: built.contentHash, check_status: "test_ok" })]);
    (h.adapter.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("thread deleted"));
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result.kept).toBe(1);
    expect(result.failed).toBe(1);
    expect(h.surfaces.setControlsMessageId).not.toHaveBeenCalled();
  });

  it("keeps reconciling the other posts when one Discord edit fails", async () => {
    const stale = candidate({ checkStatus: "running" });
    const h = harness([surface({ content_hash: stale.contentHash, check_status: "running", controls_message_id: "c-1" })]);
    h.adapter.update = vi.fn(async () => {
      throw new Error("thread is archived");
    });
    const fresh = candidate({ checkStatus: "test_ok" });
    const other = buildTestForumCandidates([openPr({ id: "local-pr-43", number: 43 })])[0];
    const warn = vi.fn();
    const result = await reconcileTestForum({ candidates: [fresh, other], ...h, log: { warn } });
    // 失敗した投稿は kept のまま (二重投稿しない) で DB も据え置き、 次周期で再試行する。
    expect(result).toEqual({ scanned: 1, kept: 1, updated: 0, created: 1, closed: 0, failed: 1 });
    expect(h.surfaces.updateContent).not.toHaveBeenCalled();
    expect(h.adapter.create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("replaces a legacy surface without a safe spawn target", async () => {
    const legacy = surface({
      worktree_path: "E:/Document/Ars/Concordia-test-forum",
      repo_root_path: null,
      head_branch: null,
    });
    const h = harness([legacy]);
    const result = await reconcileTestForum({ candidates: [candidate()], ...h });
    expect(result).toEqual({ scanned: 1, kept: 0, updated: 0, created: 1, closed: 1, failed: 0 });
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "spawn-target-updated");
  });
});
