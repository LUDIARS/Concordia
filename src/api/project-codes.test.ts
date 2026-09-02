import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { projectCodesRouter } from "./project-codes.js";

// git 検査は module mock でなく DI (deps.repoContext) で差し替える。
// isolate:false の registry 共有では vi.mock がロード順依存で効かないことがある。
const inspectImplementationRepo = vi.fn();
const isWithinWorkspace = vi.fn();
const repoContext = { inspectImplementationRepo, isWithinWorkspace } as never;

const storedRow: ProjectCodeRow = {
  code: "Cc",
  project: "Concordia",
  repo_path: "E:/Document/Ars/Concordia",
  repo_origin: "should-not-leak",
  added_by: "test-actor",
  created_at: 1,
  updated_at: 2,
};

describe("projectCodesRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only fields needed by project-code consumers", async () => {
    const app = projectCodesRouter({
      repo: { list: () => [storedRow] } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
    });

    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      source: "concordia-db",
      project_codes: [{ code: "Cc", project: "Concordia", repo_path: storedRow.repo_path }],
      categories: [{ name: "Concordia registry", entries: [["Cc", "Concordia"]] }],
    });
    expect(JSON.stringify(body)).not.toContain("should-not-leak");
    expect(JSON.stringify(body)).not.toContain("test-actor");
  });

  it("registers the inspected canonical repository and redacts audit fields from the response", async () => {
    isWithinWorkspace.mockResolvedValue(true);
    inspectImplementationRepo.mockResolvedValue({
      repoPath: storedRow.repo_path,
      repoOrigin: storedRow.repo_origin,
      branch: "main",
    });
    const register = vi.fn(() => ({ row: storedRow, created: true }));
    const app = projectCodesRouter({
      repo: { list: () => [], register } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      repoContext,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "Cc",
        repo_path: "E:/Document/Ars/Concordia/src",
        added_by: storedRow.added_by,
      }),
    });

    expect(response.status).toBe(201);
    expect(register).toHaveBeenCalledWith({
      code: "Cc",
      project: "Concordia",
      repoPath: storedRow.repo_path,
      repoOrigin: storedRow.repo_origin,
      addedBy: storedRow.added_by,
    });
    expect(await response.json()).toEqual({
      project_code: { code: "Cc", project: "Concordia", repo_path: storedRow.repo_path },
      created: true,
    });
  });

  it("prefers an explicit repo_origin over the inspected git origin", async () => {
    isWithinWorkspace.mockResolvedValue(true);
    inspectImplementationRepo.mockResolvedValue({
      repoPath: storedRow.repo_path,
      repoOrigin: "https://github.com/LUDIARS/from-git.git",
      branch: "main",
    });
    const register = vi.fn(() => ({ row: storedRow, created: true }));
    const app = projectCodesRouter({
      repo: { list: () => [], register } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      repoContext,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "Cc",
        repo_path: storedRow.repo_path,
        repo_origin: "https://github.com/LUDIARS/explicit.git",
      }),
    });

    expect(response.status).toBe(201);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      repoOrigin: "https://github.com/LUDIARS/explicit.git",
    }));
  });

  it("rejects an explicit repo_origin containing credentials before Git inspection", async () => {
    const app = projectCodesRouter({
      repo: { list: () => [], register: vi.fn() } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      repoContext,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "Cc",
        repo_path: storedRow.repo_path,
        repo_origin: "https://username@github.com/LUDIARS/explicit.git",
      }),
    });

    expect(response.status).toBe(400);
    expect(inspectImplementationRepo).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("username@");
  });

  it("prefers an explicit project name over the directory basename", async () => {
    isWithinWorkspace.mockResolvedValue(true);
    inspectImplementationRepo.mockResolvedValue({
      repoPath: storedRow.repo_path,
      repoOrigin: storedRow.repo_origin,
      branch: "main",
    });
    const register = vi.fn(() => ({ row: storedRow, created: true }));
    const app = projectCodesRouter({
      repo: { list: () => [], register } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      repoContext,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "Cc",
        repo_path: storedRow.repo_path,
        project: "ConcordiaHub",
      }),
    });

    expect(response.status).toBe(201);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ project: "ConcordiaHub" }));
  });

  it("rejects paths outside configured workspace roots before Git inspection", async () => {
    isWithinWorkspace.mockResolvedValue(false);
    const app = projectCodesRouter({
      repo: { list: () => [] } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      repoContext,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "Cc", repo_path: "E:/private/Concordia" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "repository_outside_workspace" });
    expect(inspectImplementationRepo).not.toHaveBeenCalled();
  });
});
