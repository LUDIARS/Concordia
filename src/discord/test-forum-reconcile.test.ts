import { describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrDetail, RevisorTestWorkflowProduct } from "../pr/revisor-test-workflow-client.js";
import {
  buildTestForumCandidates,
  reconcileTestForum,
  type TestForumCandidate,
  type TestForumQaHooks,
  type TestForumSurfaceAdapter,
} from "./test-forum-reconcile.js";

function product(headSha = "sha-1"): RevisorTestWorkflowProduct {
  return {
    repository: "LUDIARS/Concordia",
    pullRequestId: "local-pr-42",
    number: 42,
    title: "Test Forum",
    status: "Open / Test OK",
    headRef: "feat/test-forum",
    repositoryRootPath: "E:/Document/Ars/Concordia",
    reviewedHeadSha: headSha,
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

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

function candidate(headSha = "sha-1"): TestForumCandidate {
  return buildTestForumCandidates([product(headSha)])[0];
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
      });
      rows.push(row);
      return row;
    }),
    updateContent: vi.fn((id, input) => {
      const row = rows.find((entry) => entry.id === id);
      if (row) {
        row.head_sha = input.headSha;
        row.content_hash = input.contentHash;
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
    close: vi.fn(async () => undefined),
  };
  const qa: TestForumQaHooks = {
    start: vi.fn(async () => "run-qa-1"),
    end: vi.fn(async () => undefined),
  };
  return { surfaces, adapter, qa, rows };
}

describe("buildTestForumCandidates", () => {
  it("projects Revisor products and attaches details by pullRequestId", () => {
    const details = new Map([["local-pr-42", detail()]]);
    const [built] = buildTestForumCandidates([product()], details);
    expect(built.repoOrigin).toBe("LUDIARS/Concordia");
    expect(built.prNumber).toBe(42);
    expect(built.detail?.decisionLabel).toBe("自動マージ可");
    expect(built.headBranch).toBe("feat/test-forum");
    expect(built.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the content hash when the detail changes, and keeps it stable otherwise", () => {
    const a = buildTestForumCandidates([product()], new Map([["local-pr-42", detail()]]))[0];
    const b = buildTestForumCandidates([product()], new Map([["local-pr-42", detail()]]))[0];
    const c = buildTestForumCandidates(
      [product()],
      new Map([["local-pr-42", detail({ blockers: ["動作確認が必要"] })]]),
    )[0];
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });
});

describe("reconcileTestForum", () => {
  it("creates one surface for a Revisor Open / Test OK product and starts a QA session", async () => {
    const h = harness();
    const built = candidate();
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result).toEqual({ scanned: 0, kept: 0, updated: 0, created: 1, closed: 0, failed: 0 });
    expect(h.surfaces.create).toHaveBeenCalledWith(expect.objectContaining({
      headSha: "sha-1",
      contentHash: built.contentHash,
      repoRootPath: "E:/Document/Ars/Concordia",
      headBranch: "feat/test-forum",
      worktreePath: null,
    }));
    expect(h.qa.start).toHaveBeenCalledWith(built, expect.any(String));
    expect(h.surfaces.setQaRun).toHaveBeenCalledWith(expect.any(Number), "run-qa-1");
  });

  it("closes a surface and ends its QA session when Revisor no longer lists the product", async () => {
    const h = harness([surface({ qa_run_id: "run-qa-9" })]);
    const result = await reconcileTestForum({ candidates: [], ...h });
    expect(result.closed).toBe(1);
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "candidate-unavailable");
    expect(h.qa.end).toHaveBeenCalledWith(expect.objectContaining({ qa_run_id: "run-qa-9" }));
    expect(h.adapter.create).not.toHaveBeenCalled();
  });

  it("refreshes a changed post by editing instead of close-and-recreate", async () => {
    const stale = candidate("sha-old");
    const h = harness([surface({ head_sha: "sha-old", content_hash: stale.contentHash })]);
    const fresh = candidate("sha-new");
    const result = await reconcileTestForum({ candidates: [fresh], ...h });
    expect(result).toEqual({ scanned: 1, kept: 1, updated: 1, created: 0, closed: 0, failed: 0 });
    expect(h.adapter.update).toHaveBeenCalledWith(expect.anything(), fresh);
    expect(h.surfaces.updateContent).toHaveBeenCalledWith(7, {
      headSha: "sha-new",
      contentHash: fresh.contentHash,
    });
    expect(h.adapter.close).not.toHaveBeenCalled();
    // 既存投稿の更新では QA セッションを起動し直さない。
    expect(h.qa.start).not.toHaveBeenCalled();
  });

  it("leaves an unchanged post alone (no Discord edit)", async () => {
    const built = candidate();
    const h = harness([surface({ content_hash: built.contentHash })]);
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result).toEqual({ scanned: 1, kept: 1, updated: 0, created: 0, closed: 0, failed: 0 });
    expect(h.adapter.update).not.toHaveBeenCalled();
  });

  it("still publishes when the QA spawn fails", async () => {
    const h = harness();
    h.qa.start = vi.fn(async () => null);
    const result = await reconcileTestForum({ candidates: [candidate()], ...h });
    expect(result.created).toBe(1);
    expect(h.surfaces.setQaRun).not.toHaveBeenCalled();
  });

  it("attaches the control message to a newly created surface", async () => {
    const h = harness();
    await reconcileTestForum({ candidates: [candidate()], ...h });
    expect(h.surfaces.setControlsMessageId).toHaveBeenCalledWith(10, "controls-10");
  });

  it("still starts the QA session when the new post's controls cannot be rendered", async () => {
    // 操作面の描画失敗で QA 起動を巻き添えにすると、 次周期はこの候補が「保持」側に
    // 回るので QA が二度と起動しない。 操作面だけ次周期の backfill に任せる。
    const h = harness();
    (h.adapter.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("thread archived"));
    const result = await reconcileTestForum({ candidates: [candidate()], ...h });
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(h.qa.start).toHaveBeenCalledOnce();
    expect(h.surfaces.setQaRun).toHaveBeenCalledWith(10, "run-qa-1");
  });

  it("backfills controls onto surfaces posted before the controls existed", async () => {
    // 操作面の導入前に立った投稿は controls_message_id を持たない。 head が変わるまで
    // 操作が出ないままにしない。
    const built = candidate();
    const h = harness([surface({ content_hash: built.contentHash })]);
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result).toEqual({ scanned: 1, kept: 1, updated: 0, created: 0, closed: 0, failed: 0 });
    expect(h.surfaces.setControlsMessageId).toHaveBeenCalledWith(7, "controls-7");
  });

  it("keeps reconciling when a kept thread can no longer be rendered", async () => {
    const built = candidate();
    const h = harness([surface({ content_hash: built.contentHash })]);
    (h.adapter.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("thread deleted"));
    const result = await reconcileTestForum({ candidates: [built], ...h });
    expect(result.kept).toBe(1);
    expect(result.failed).toBe(1);
    expect(h.surfaces.setControlsMessageId).not.toHaveBeenCalled();
  });

  it("keeps reconciling the other posts when one Discord edit fails", async () => {
    const stale = candidate("sha-old");
    const h = harness([surface({ head_sha: "sha-old", content_hash: stale.contentHash })]);
    h.adapter.update = vi.fn(async () => {
      throw new Error("thread is archived");
    });
    const fresh = candidate("sha-new");
    const other: TestForumCandidate = { ...candidate(), prNumber: 43 };
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
