import { describe, expect, it, vi } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import type { RevisorRepositoryRecord } from "../pr/revisor-repository-client.js";
import { projectRevisorTestsRouter } from "./project-revisor-tests.js";

const row = {
  code: "Eg",
  project: "Ergo",
  repo_path: "D:/LUDIARS/Ergo",
  repo_origin: "https://github.com/LUDIARS/Ergo.git",
} as ProjectCodeRow;

function record(names: string[]): RevisorRepositoryRecord {
  return {
    repository: "LUDIARS/Ergo",
    rootPath: "D:/LUDIARS/Ergo",
    baseRef: "main",
    workflow: "github",
    testCases: names.map((name) => ({ name, command: "npm", args: ["test"], cwd: ".", timeoutMs: 600_000, kinds: null })),
  };
}

function setup(current: RevisorRepositoryRecord | null, options: { failSave?: boolean; unreachable?: boolean } = {}) {
  const setRepositoryTestCases = vi.fn(async () => {
    if (options.failSave) throw new Error("Revisor repository test cases update failed (400): secret detail");
  });
  const onChanged = vi.fn();
  const app = projectRevisorTestsRouter({
    repo: { findByCode: (code: string) => (code === row.code ? row : null) },
    revisor: {
      listRepositories: async () => {
        if (options.unreachable) throw new Error("down");
        return current ? [current] : [];
      },
      setRepositoryTestCases,
    },
    onChanged,
  });
  return { app, setRepositoryTestCases, onChanged };
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("projectRevisorTestsRouter", () => {
  it("lists the registered test cases in API shape", async () => {
    const { app } = setup(record(["cpp-unit"]));
    const response = await app.request("/Eg/revisor-tests");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repository: "LUDIARS/Ergo",
      test_cases: [{
        name: "cpp-unit", command: "npm", args: ["test"], cwd: ".", timeout_ms: 600_000,
        kinds: null, runtime: false, always: false,
      }],
    });
  });

  it("appends one case with defaults and keeps the existing ones", async () => {
    const current = record(["cpp-unit"]);
    const { app, setRepositoryTestCases, onChanged } = setup(current);
    const response = await app.request("/Eg/revisor-tests", json({ name: "lint", command: "npm", args: ["run", "lint"] }));
    expect(response.status).toBe(201);
    expect(setRepositoryTestCases).toHaveBeenCalledWith(current, [
      current.testCases[0],
      { name: "lint", command: "npm", args: ["run", "lint"], cwd: ".", timeoutMs: 600_000, kinds: null, runtime: false, always: false },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("removes only the named case", async () => {
    const current = record(["tools-unit", "cpp-unit"]);
    const { app, setRepositoryTestCases } = setup(current);
    const response = await app.request("/Eg/revisor-tests/tools-unit", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(setRepositoryTestCases).toHaveBeenCalledWith(current, [current.testCases[1]]);
  });

  it("refuses to delete the last case because Revisor requires at least one", async () => {
    const { app, setRepositoryTestCases } = setup(record(["cpp-unit"]));
    const response = await app.request("/Eg/revisor-tests/cpp-unit", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "revisor_test_case_last" });
    expect(setRepositoryTestCases).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "x", command: "npm & calc" }, 400, "invalid_revisor_test_case"],
    [{ name: "x", command: "npm", cwd: "../outside" }, 400, "invalid_revisor_test_case"],
    [{ name: "x", command: "npm", cwd: "C:\\outside" }, 400, "invalid_revisor_test_case"],
    [{ name: "x", command: "npm", kinds: ["dependency"] }, 400, "invalid_revisor_test_case"],
    [{ name: "cpp-unit", command: "npm" }, 409, "revisor_test_case_exists"],
  ])("rejects %j", async (body, status, error) => {
    const { app, setRepositoryTestCases } = setup(record(["cpp-unit"]));
    const response = await app.request("/Eg/revisor-tests", json(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(setRepositoryTestCases).not.toHaveBeenCalled();
  });

  it("refuses the 33rd case", async () => {
    const { app } = setup(record(Array.from({ length: 32 }, (_, index) => `t${index}`)));
    const response = await app.request("/Eg/revisor-tests", json({ name: "extra", command: "npm" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "revisor_test_case_limit" });
  });

  it("separates unknown, unregistered and missing names", async () => {
    expect((await setup(null).app.request("/Eg/revisor-tests")).status).toBe(409);
    expect((await setup(null, { unreachable: true }).app.request("/Eg/revisor-tests")).status).toBe(502);
    expect((await setup(record(["a", "b"])).app.request("/Eg/revisor-tests/c", { method: "DELETE" })).status).toBe(404);
    expect((await setup(record(["a"])).app.request("/Zz/revisor-tests")).status).toBe(404);
  });

  it("does not pass the Revisor error body to the browser", async () => {
    const { app, onChanged } = setup(record(["a", "b"]), { failSave: true });
    const response = await app.request("/Eg/revisor-tests/a", { method: "DELETE" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "revisor_test_cases_update_failed" });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
