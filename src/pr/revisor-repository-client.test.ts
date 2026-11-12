import { describe, expect, it, vi } from "vitest";
import { RevisorRepositoryClient } from "./revisor-repository-client.js";

const excubitor = {
  findService: vi.fn(async () => ({ code: "revisor", name: "Revisor", port: 4240, state: "running" })),
};

describe("RevisorRepositoryClient", () => {
  it("lists validated registrations without requiring a workflow token or GitHub App", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      repositories: [{
        repository: "LUDIARS/Concordia",
        rootPath: "E:/Document/Ars/Concordia",
        baseRef: "main",
        workflow: "github",
        testCases: [{ name: "test", command: "npm", args: ["test"], cwd: ".", timeoutMs: 600_000 }],
      }],
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

  it("rejects malformed rows instead of treating their repositories as unregistered", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ repositories: [
      { repository: "LUDIARS/Concordia", rootPath: "E:/Concordia", baseRef: "main" },
    ] }), { status: 200 }));
    const client = new RevisorRepositoryClient({ excubitor, fetchImpl });
    await expect(client.listRepositories()).rejects.toThrow("invalid repository record");
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

  it("gives up once catalog lookup has consumed the whole timeout budget", async () => {
    // 遅い catalog 照会を予算の外に置くと待ち時間が青天井になり、 呼び出し元の HTTP handler
    // ごと event loop が止まる (2026-09-12 の実測: services/:code が 39 秒 → PATCH が 753 秒)。
    const findService = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { code: "revisor", name: "Revisor", port: 4240, state: "running" };
    });
    const fetchImpl = vi.fn();
    const client = new RevisorRepositoryClient({ excubitor: { findService }, fetchImpl, timeoutMs: 20 });

    await expect(client.listRepositories()).rejects.toThrow("timed out resolving");
    // 予算を使い切っているので Revisor 本体への往復は始めない。
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves the catalog lookup enough budget to still reach Revisor", async () => {
    const findService = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { code: "revisor", name: "Revisor", port: 4240, state: "running" };
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ repositories: [] }), { status: 200 }));
    const client = new RevisorRepositoryClient({ excubitor: { findService }, fetchImpl, timeoutMs: 5_000 });

    await expect(client.listRepositories()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("replaces test cases without sending a workflow so Revisor keeps the existing one", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 201 }));
    const client = new RevisorRepositoryClient({ excubitor, token: "workflow-secret", fetchImpl });
    const record = {
      repository: "LUDIARS/Ergo",
      rootPath: "D:/LUDIARS/Ergo",
      baseRef: "main",
      workflow: "github" as const,
      testCases: [{ name: "tools-unit", command: "npm", args: ["test"], cwd: ".", timeoutMs: 600_000 }],
    };

    await client.setRepositoryTestCases(record, [
      { name: "cpp-unit", command: "ctest", args: ["--test-dir", "build"], cwd: ".", timeoutMs: 1_800_000 },
    ]);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual(expect.objectContaining({ authorization: "Bearer workflow-secret" }));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("workflow");
    expect(body).toEqual({
      repository: "LUDIARS/Ergo",
      root_path: "D:/LUDIARS/Ergo",
      base_ref: "main",
      test_cases: [{
        name: "cpp-unit", command: "ctest", args: ["--test-dir", "build"], cwd: ".",
        timeout_ms: 1_800_000, kinds: null, runtime: false, always: false,
      }],
    });
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
