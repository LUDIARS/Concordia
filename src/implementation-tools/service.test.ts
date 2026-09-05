import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { ImplementationToolsService } from "./service.js";

const { inspectImplementationRepo, isWithinWorkspace } = vi.hoisted(() => ({
  inspectImplementationRepo: vi.fn(),
  isWithinWorkspace: vi.fn(),
}));

vi.mock("./repo-context.js", () => ({ inspectImplementationRepo, isWithinWorkspace }));

const row: ProjectCodeRow = {
  code: "Cc",
  project: "Concordia",
  repo_path: "E:/Document/Ars/Concordia",
  repo_origin: "https://github.com/LUDIARS/Concordia.git",
  github_issue_workflow: 0,
  added_by: "test",
  created_at: 1,
  updated_at: 1,
};

describe("ImplementationToolsService project-code binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isWithinWorkspace.mockResolvedValue(true);
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
  });
});
