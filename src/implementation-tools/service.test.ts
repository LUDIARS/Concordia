import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { eventBus } from "../events.js";
import { ImplementationToolsService } from "./service.js";

const { inspectImplementationRepo, isWithinWorkspace, mainRepositoryKey } = vi.hoisted(() => ({
  inspectImplementationRepo: vi.fn(),
  isWithinWorkspace: vi.fn(),
  mainRepositoryKey: vi.fn(),
}));

vi.mock("./repo-context.js", () => ({ inspectImplementationRepo, isWithinWorkspace }));
vi.mock("../taskflow/repository-identity.js", () => ({ mainRepositoryKey }));

const row: ProjectCodeRow = {
  code: "Cc",
  project: "Concordia",
  repo_path: "E:/Document/Ars/Concordia",
  repo_origin: "https://github.com/LUDIARS/Concordia.git",
  domain_review: 1,
  github_issue_workflow: 0,
  added_by: "test",
  created_at: 1,
  updated_at: 1,
};

describe("ImplementationToolsService project-code binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isWithinWorkspace.mockResolvedValue(true);
    mainRepositoryKey.mockResolvedValue(row.repo_path);
    inspectImplementationRepo.mockResolvedValue({
      repoPath: row.repo_path,
      repoOrigin: row.repo_origin,
      branch: "feat/project-code",
    });
  });

  it("observes a registration on the next bind without recreating the service", async () => {
    const rows: ProjectCodeRow[] = [];
    const patchSession = vi.fn();
    const mergeMetadata = vi.fn();
    const appendEvent = vi.fn();
    const service = new ImplementationToolsService({
      sessions: {
        findSession: () => ({
          id: "session-1",
          status: "active",
          repo_path: "E:/Document/Ars",
          branch: "main",
          active_repos: "[]",
        }),
        patchSession,
        mergeMetadata,
        appendEvent,
      } as never,
      claims: {} as never,
      excubitor: {} as never,
      submitLocalPr: vi.fn(),
      projectCodes: { list: () => rows } as never,
      work: {} as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
    });

    await expect(service.bind({
      sessionId: "session-1",
      cwd: row.repo_path,
      task: "registry migration",
    })).rejects.toThrow("project code could not be resolved");

    rows.push(row);
    await expect(service.bind({
      sessionId: "session-1",
      cwd: row.repo_path,
      task: "registry migration",
    })).resolves.toEqual({
      ok: true,
      project_code: "Cc",
      task: "[Cc] registry migration",
      branch: "feat/project-code",
    });
    expect(patchSession).toHaveBeenCalledWith("session-1", expect.objectContaining({
      target_project: row.repo_path,
      repo_origin: row.repo_origin,
      active_repos: [row.repo_path],
    }));
    expect(mergeMetadata).toHaveBeenCalled();
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "implementation.tool.bind",
    }));
    // Repository names are not identities: a linked checkout can have any directory name.
    inspectImplementationRepo.mockResolvedValueOnce({
      repoPath: "E:/Document/Ars/renamed-checkout", repoOrigin: row.repo_origin, branch: "feat/new",
    });
    await expect(service.bind({ sessionId: "session-1", cwd: "E:/Document/Ars/renamed-checkout", task: "next" }))
      .resolves.toMatchObject({ project_code: "Cc", branch: "feat/new" });
  });

  // 契約 (contract/lifecycle.ts) は session.task_changed でしか作られない。 bind が出さないと
  // Castra で起動して implement begin で Cc に入ったセッションは契約が作られず編集が全て拒否された。
  it("emits session.task_changed so the session contract is seeded after an implement begin", async () => {
    const session = { id: "session-1", status: "active", repo_path: "E:/Document/Ars", repo_origin: "https://github.com/LUDIARS/Castra.git", branch: "main", active_repos: "[]", current_task: "castra work" };
    const events: unknown[] = [];
    const unsubscribe = eventBus.subscribe((event) => { if (event.type === "session.task_changed") events.push(event); });
    try {
      const service = new ImplementationToolsService({
        sessions: { findSession: () => session, patchSession: vi.fn(), mergeMetadata: vi.fn(), appendEvent: vi.fn() } as never,
        claims: {} as never,
        excubitor: {} as never,
        submitLocalPr: vi.fn(),
        projectCodes: { list: () => [row] } as never,
        work: {} as never,
        resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      });
      await service.bind({ sessionId: "session-1", cwd: row.repo_path, task: "federation" });
      expect(events).toEqual([expect.objectContaining({
        type: "session.task_changed",
        session_id: "session-1",
        previous_task: "castra work",
        current_task: "[Cc] federation",
      })]);

      // 同じ task・同じ作業場所への bind し直しでは出さない (契約の再生成を無駄に起こさない)。
      events.length = 0;
      Object.assign(session, { repo_path: row.repo_path, repo_origin: row.repo_origin, current_task: "[Cc] federation" });
      await service.bind({ sessionId: "session-1", cwd: row.repo_path, task: "federation" });
      expect(events).toEqual([]);

      // task が同じでも作業場所 (repo) が変われば契約対象が変わりうるので出す。
      Object.assign(session, { repo_path: "E:/Document/Ars", repo_origin: "https://github.com/LUDIARS/Castra.git" });
      await service.bind({ sessionId: "session-1", cwd: row.repo_path, task: "federation" });
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});
