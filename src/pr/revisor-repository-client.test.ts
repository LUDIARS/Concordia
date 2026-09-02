import { describe, expect, it, vi } from "vitest";
import { RevisorRepositoryClient } from "./revisor-repository-client.js";

const excubitor = {
  findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })),
};

describe("RevisorRepositoryClient", () => {
  it("lists validated registrations and drops malformed rows", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      repositories: [{
        repository: "LUDIARS/Concordia",
        rootPath: "E:/Document/Ars/Concordia",
        baseRef: "main",
        workflow: "github",
        testCases: [{ name: "test", command: "npm", args: ["test"], cwd: ".", timeoutMs: 600_000 }],
      }, { repository: "broken", rootPath: "E:/broken", baseRef: "main" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new RevisorRepositoryClient({ excubitor, fetchImpl });

    await expect(client.listRepositories()).resolves.toEqual([expect.objectContaining({
      repository: "LUDIARS/Concordia",
      workflow: "github",
      testCases: [expect.objectContaining({ name: "test", timeoutMs: 600_000 })],
    })]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4240/v1/repositories",
      expect.objectContaining({ headers: { "x-concordia-actor": "concordia" } }),
    );
  });

  it("authenticates workflow updates and preserves registration tests", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = new RevisorRepositoryClient({ excubitor, token: "workflow-secret", fetchImpl });
    const record = {
      repository: "LUDIARS/Concordia",
      rootPath: "E:/Document/Ars/Concordia",
      baseRef: "main",
      testCases: [{ name: "test", command: "npm", args: ["test"], cwd: ".", timeoutMs: 600_000 }],
    };

    await expect(client.setRepositoryWorkflow(record, "github")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4240/v1/repositories",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer workflow-secret",
          "x-concordia-actor": "concordia",
        }),
        body: expect.stringContaining('"timeout_ms":600000'),
      }),
    );
  });

  it("refuses updates before service discovery when the token is unset", async () => {
    const fetchImpl = vi.fn();
    const findService = vi.fn();
    const client = new RevisorRepositoryClient({ excubitor: { findService }, fetchImpl });
    await expect(client.setRepositoryWorkflow({
      repository: "LUDIARS/Concordia",
      rootPath: "E:/Document/Ars/Concordia",
      baseRef: "main",
      testCases: [],
    }, "github")).rejects.toThrow("token is required");
    expect(findService).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
