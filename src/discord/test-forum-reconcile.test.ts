import { describe, expect, it, vi } from "vitest";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { PrRecordRow, PrState } from "../db/pr-records-repo.js";
import type { RepoStatus } from "../work/repo-scan.js";
import { reconcileTestForum, type TestForumSurfaceAdapter } from "./test-forum-reconcile.js";

function pr(state: PrState = "open", headSha = "sha-1"): PrRecordRow {
  return {
    id: 1,
    repo_origin: "LUDIARS/Concordia",
    repo_path: "E:/Document/Ars/Concordia",
    number: 42,
    title: "Test Forum",
    url: "https://github.com/LUDIARS/Concordia/pull/42",
    head_branch: "feat/test-forum",
    head_sha: headSha,
    base_branch: "main",
    state,
    ci_status: "success",
    review_state: "approved",
    author_session_id: null,
    persona_id: null,
    persona_name: null,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    note: null,
    created_at: 1,
    updated_at: 1,
    merged_at: state === "merged" ? 2 : null,
    closed_at: state === "closed" ? 2 : null,
  };
}

function repo(withWorktree = true): RepoStatus {
  return {
    name: "Concordia",
    path: "E:/Document/Ars/Concordia",
    branch: "main",
    detached: false,
    is_worktree: false,
    default_branch: "main",
    on_default_branch: true,
    worktrees: withWorktree
      ? [{ path: "E:/Document/Ars/Concordia-test-forum", branch: "feat/test-forum", is_main: false }]
      : [{ path: "E:/Document/Ars/Concordia", branch: "main", is_main: true }],
    extra_worktree_count: withWorktree ? 1 : 0,
    updated_at: 1,
    sessions: [],
    error: null,
  };
}

function surface(headSha = "sha-1"): DiscordTestSurfaceRow {
  return {
    id: 7,
    scope: "",
    repo_origin: "LUDIARS/Concordia",
    pr_number: 42,
    head_sha: headSha,
    worktree_path: "E:/Document/Ars/Concordia-test-forum",
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
  it("creates one surface for a current open PR head and matching worktree", async () => {
    const h = harness();
    const result = await reconcileTestForum({ prs: [pr()], repos: [repo()], ...h });
    expect(result).toEqual({ scanned: 0, kept: 0, created: 1, closed: 0 });
    expect(h.surfaces.create).toHaveBeenCalledWith(expect.objectContaining({
      headSha: "sha-1",
      worktreePath: "E:/Document/Ars/Concordia-test-forum",
    }));
  });

  it.each([
    ["merged", "pr-merged"],
    ["closed", "pr-closed"],
  ] as const)("closes a surface when its PR becomes %s", async (state, reason) => {
    const h = harness([surface()]);
    const result = await reconcileTestForum({ prs: [pr(state)], repos: [repo()], ...h });
    expect(result.closed).toBe(1);
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), reason);
    expect(h.adapter.create).not.toHaveBeenCalled();
  });

  it("closes an obsolete head and creates a replacement for the updated open PR", async () => {
    const h = harness([surface("sha-old")]);
    const result = await reconcileTestForum({ prs: [pr("open", "sha-new")], repos: [repo()], ...h });
    expect(result).toEqual({ scanned: 1, kept: 0, created: 1, closed: 1 });
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "head-updated");
    expect(h.surfaces.create).toHaveBeenCalledWith(expect.objectContaining({ headSha: "sha-new" }));
  });

  it("closes a worktree-linked surface without recreating it when that worktree disappears", async () => {
    const h = harness([surface()]);
    const result = await reconcileTestForum({ prs: [pr()], repos: [repo(false)], ...h });
    expect(result).toEqual({ scanned: 1, kept: 0, created: 0, closed: 1 });
    expect(h.adapter.close).toHaveBeenCalledWith(expect.anything(), "worktree-removed");
  });
});
