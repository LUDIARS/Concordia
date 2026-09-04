import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { ownerRepoFromOrigin, projectCodesRouter } from "./project-codes.js";

// repo-context は mock しない — 本 suite は inspect を通る経路 (register / repo_path 変更)
// を扱わず、 同 module の mock は project-codes.test.ts と registry を共有して衝突する
// (Cc は isolate:false — vi.mock の cross-file 干渉に注意)。

const storedRow: ProjectCodeRow = {
  code: "Cc",
  project: "Concordia",
  repo_path: "E:/Document/Ars/Concordia",
  repo_origin: "https://github.com/LUDIARS/Concordia.git",
  added_by: "test-actor",
  created_at: 1,
  updated_at: 2,
};

function adminDeps(overrides: Record<string, unknown> = {}) {
  return {
    repo: {
      list: () => [storedRow],
      findByCode: (code: string) => (code === storedRow.code ? storedRow : null),
    },
    resolveWorkspaceRoots: () => ["E:/Document/Ars"],
    teams: {
      list: () => [{ id: "team-1", name: "SampleLab" }],
      find: (id: string) => (id === "team-1" ? { id: "team-1", name: "SampleLab" } : null),
      listRepoAssignments: () => [{ team_id: "team-1", repo_origin: storedRow.repo_origin! }],
      assignRepoToTeams: vi.fn(),
      moveRepoAssignment: vi.fn(),
    },
    subsidiaries: {
      list: () => [{ id: "sub-1", name: "ditest", display_name: "DiTest" }],
      find: (id: string) => (id === "sub-1" ? { id: "sub-1" } : null),
      listProjectAssignments: () => [{ subsidiary_id: "sub-1", project: storedRow.project }],
      assignProjectToSubsidiaries: vi.fn(),
      moveProjectAssignment: vi.fn(),
    },
    ...overrides,
  };
}

describe("projectCodesRouter admin surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns full rows with team / subsidiary / revisor enrichment", async () => {
    const revisorRecord = {
      repository: "LUDIARS/Concordia",
      rootPath: storedRow.repo_path,
      baseRef: "main",
      workflow: "github",
      testCases: [],
    };
    const app = projectCodesRouter(adminDeps({
      revisor: { listRepositories: async () => [revisorRecord], setRepositoryWorkflow: vi.fn() },
    }) as never);
    const response = await app.request("/admin");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries[0]).toMatchObject({
      code: "Cc",
      repo_origin: storedRow.repo_origin,
      teams: [{ id: "team-1", name: "SampleLab" }],
      subsidiaries: [{ id: "sub-1", name: "DiTest" }],
      revisor: { registered: true, workflow: "github" },
    });
    expect(body.revisor_available).toBe(true);
    expect(body.teams).toEqual([{ id: "team-1", name: "SampleLab" }]);
    expect(body.subsidiaries).toEqual([{ id: "sub-1", name: "DiTest" }]);
  });

  it("marks unregistered repositories when Revisor is reachable but has no record", async () => {
    const app = projectCodesRouter(adminDeps({
      revisor: { listRepositories: async () => [], setRepositoryWorkflow: vi.fn() },
    }) as never);
    const body = await (await app.request("/admin")).json();
    expect(body.entries[0].revisor).toEqual({ registered: false, workflow: null });
  });

  it("moves the repository between teams by repo_origin", async () => {
    const deps = adminDeps();
    const app = projectCodesRouter(deps as never);
    const response = await app.request("/Cc/team", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ team_ids: ["team-1"] }),
    });
    expect(response.status).toBe(200);
    expect(deps.teams.assignRepoToTeams).toHaveBeenCalledWith(storedRow.repo_origin, ["team-1"]);
  });

  it("moves the project between subsidiaries (empty = head office only)", async () => {
    const deps = adminDeps();
    const app = projectCodesRouter(deps as never);
    const response = await app.request("/Cc/subsidiary", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subsidiary_ids: [] }),
    });
    expect(response.status).toBe(200);
    expect(deps.subsidiaries.assignProjectToSubsidiaries).toHaveBeenCalledWith(storedRow.project, []);
  });

  it("round-trips the Revisor registration when changing the workflow", async () => {
    const revisorRecord = {
      repository: "LUDIARS/Concordia",
      rootPath: storedRow.repo_path,
      baseRef: "main",
      testCases: [
        { name: "test", command: "npm", args: ["test"], cwd: ".", timeoutMs: 600000, kinds: null },
      ],
    };
    const setRepositoryWorkflow = vi.fn(async () => undefined);
    const app = projectCodesRouter(adminDeps({
      revisor: { listRepositories: async () => [revisorRecord], setRepositoryWorkflow },
    }) as never);
    const response = await app.request("/Cc/revisor-workflow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "github" }),
    });
    expect(response.status).toBe(200);
    expect(setRepositoryWorkflow).toHaveBeenCalledWith(revisorRecord, "github");
  });

  it("refuses a workflow change for a repository Revisor does not know", async () => {
    const app = projectCodesRouter(adminDeps({
      revisor: { listRepositories: async () => [], setRepositoryWorkflow: vi.fn() },
    }) as never);
    const response = await app.request("/Cc/revisor-workflow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "github" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "revisor_not_registered" });
  });

  it("updates registry fields through PATCH", async () => {
    const update = vi.fn(() => ({ ...storedRow, code: "Co" }));
    const app = projectCodesRouter({
      repo: { list: () => [], findByCode: () => storedRow, update } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
    });
    const response = await app.request("/Cc", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "Co", repo_origin: null }),
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith("Cc", { code: "Co", project: undefined, repoOrigin: null });
    expect((await response.json()).project_code.code).toBe("Co");
  });

  it("rejects a credential-bearing repo_origin without persisting or reflecting it", async () => {
    const update = vi.fn();
    const app = projectCodesRouter({
      repo: { list: () => [], findByCode: () => storedRow, update } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
    });
    const response = await app.request("/Cc", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_origin: "https://username@github.com/LUDIARS/Concordia.git",
      }),
    });

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("username@");
  });

  it("moves related assignments when project and origin change", async () => {
    const updated = {
      ...storedRow,
      project: "ConcordiaNext",
      repo_origin: "https://github.com/LUDIARS/ConcordiaNext.git",
    };
    const deps = adminDeps({
      repo: { list: () => [], findByCode: () => storedRow, update: vi.fn(() => updated) },
    });
    const app = projectCodesRouter(deps as never);
    const response = await app.request("/Cc", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: updated.project, repo_origin: updated.repo_origin }),
    });
    expect(response.status).toBe(200);
    expect(deps.teams.moveRepoAssignment).toHaveBeenCalledWith(storedRow.repo_origin, updated.repo_origin);
    expect(deps.subsidiaries.moveProjectAssignment).toHaveBeenCalledWith(storedRow.project, updated.project);
  });

  it("deletes a registration and 404s on unknown codes", async () => {
    const remove = vi.fn((code: string) => code === "Cc");
    const deps = adminDeps({ repo: {
      list: () => [],
      findByCode: (code: string) => code === "Cc" ? storedRow : null,
      remove,
    } });
    const app = projectCodesRouter(deps as never);
    expect((await app.request("/Cc", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/Zz", { method: "DELETE" })).status).toBe(404);
    expect(deps.teams.assignRepoToTeams).toHaveBeenCalledWith(storedRow.repo_origin, []);
    expect(deps.subsidiaries.assignProjectToSubsidiaries).toHaveBeenCalledWith(storedRow.project, []);
  });
});

describe("ownerRepoFromOrigin", () => {
  it("parses https / ssh origins and rejects non-repo strings", () => {
    expect(ownerRepoFromOrigin("https://github.com/LUDIARS/Concordia.git")).toBe("LUDIARS/Concordia");
    expect(ownerRepoFromOrigin("https://github.com/LUDIARS/Concordia")).toBe("LUDIARS/Concordia");
    expect(ownerRepoFromOrigin("git@github.com:PartnerOrg/BetaGame.git")).toBe("PartnerOrg/BetaGame");
    expect(ownerRepoFromOrigin("https://example.test/LUDIARS/Concordia.git")).toBeNull();
    expect(ownerRepoFromOrigin(null)).toBeNull();
    expect(ownerRepoFromOrigin("not a url")).toBeNull();
  });
});
