import { describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorTestWorkflowProduct } from "../pr/revisor-test-workflow-client.js";
import {
  buildTestForumCandidates,
  reconcileTestForum,
  type TestForumCandidate,
  type TestForumSurfaceAdapter,
} from "./test-forum-reconcile.js";

function product(headSha = "sha-1"): RevisorTestWorkflowProduct {
  return {
    repository: "LUDIARS/Concordia",
    pullRequestId: "local-pr-42",
    number: 42,
    title: "Test Forum",
    status: "Open / Test OK",
    reviewedHeadSha: headSha,
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function candidate(headSha = "sha-1", worktreePath: string | null = null): TestForumCandidate {
  return {
    repoOrigin: "LUDIARS/Concordia",
    prNumber: 42,
    title: "Test Forum",
    url: null,
    headBranch: null,
    headSha,
    worktreePath,
  };
}

function surface(headSha = "sha-1", worktreePath: string | null = null): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: headSha,
    worktree_path: worktreePath,
    thread_id: "thread-old",
    status: "open",
    created_at: 1,
    closed_at: null,
    close_reason: null,
  };
}

function harness(open: DiscordTestSurfaceRow[] = []) {
  const rows = [...open];
  const surfaces: DiscordTestSurfacesRepo = {
    listOpen: vi.fn(() => rows.filter((row) => row.status === "open")),
    create: vi.fn((input) => {
      const row = { ...surface(input.headSha), id: rows.length + 10, thread_id: input.threadId, worktree_path: input.worktreePath };
      rows.push(row);
      return row;
    }),
    close: vi.fn((id, reason) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) {
        row.status = "closed";
        row.close_reason = reason;
      }
    }),
  };
  const adapter: TestForumSurfaceAdapter = {
    create: vi.fn(async () => ({ threadId: `thread-${rows.length + 1}` })),
    close: vi.fn(async () => undefined),
  };
  return { surfaces, adapter };
}

describe("reconcileTestForum", () => {
  it("projects Revisor products into Test Forum candidates", () => {
    expect(buildTestForumCandidates([product()])).toEqual([candidate()]);
  });

  it("creates one surface for a Revisor Open / Test OK product", async () => {
    const h = harness();
    const result = await reconcileTestForum({ candidates: [candidate()], ...h });
    expect(result).toEqual({ scanned: 0, kept: 0, created: 1, closed: 0 });
    expect(h.surfaces.create).toHaveBeenCalledWith(expect.objectContaining({
      headSha: "sha-1",
      worktreePath: null,
    }));
  });

  it("closes a surface when Revisor no longer lists the product", async () => {
    const h = harness([surface()]);
    const result = await reconcileTestForum({ candidates: [], ...h });
    expect(result.closed).toBe(1);
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "candidate-unavailable");
    expect(h.adapter.create).not.toHaveBeenCalled();
  });

  it("closes an obsolete head and creates a replacement for the reviewed head", async () => {
    const h = harness([surface("sha-old")]);
    const result = await reconcileTestForum({ candidates: [candidate("sha-new")], ...h });
    expect(result).toEqual({ scanned: 1, kept: 0, created: 1, closed: 1 });
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "head-updated");
    expect(h.surfaces.create).toHaveBeenCalledWith(expect.objectContaining({ headSha: "sha-new" }));
  });

  it("replaces a legacy worktree-linked surface with the Revisor projection", async () => {
    const h = harness([surface("sha-1", "E:/Document/Ars/Concordia-test-forum")]);
    const result = await reconcileTestForum({ candidates: [candidate()], ...h });
    expect(result).toEqual({ scanned: 1, kept: 0, created: 1, closed: 1 });
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "worktree-removed");
  });
});
