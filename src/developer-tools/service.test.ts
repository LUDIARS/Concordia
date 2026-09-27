import { describe, expect, it, vi } from "vitest";
import { DeveloperToolsService, type DeveloperToolDeps } from "./service.js";

function fixture() {
  const session = { id: "own", status: "active", repo_path: "/workspace/repo", branch: "feat/tools",
    repo_origin: "LUDIARS/Concordia", metadata: null };
  const deps = {
    sessions: { findSession: vi.fn(() => session) }, roots: () => ["/workspace"],
    within: vi.fn(async () => true), inspect: vi.fn(async () => ({ repoPath: session.repo_path,
      branch: session.branch, repoOrigin: session.repo_origin })),
    tasks: { binding: vi.fn(async () => ({ teamId: "team", projectId: "project" })),
      findForProject: vi.fn(async () => []), read: vi.fn(async () => ({ title: "scoped" })), updateStatus: vi.fn(async () => {}) },
    actio: { request: vi.fn(async () => ({ taskIds: ["one"] })) },
    research: { anatomyProject: vi.fn(async () => "cc"), specifications: vi.fn(async () => ({})),
      context: vi.fn(async () => ({})), impact: vi.fn(async () => ({})) },
    augur: { cli: vi.fn(() => "/Augur/bin/augur.mjs"), list: vi.fn(async () => [{ id: "test", runtime: false, status: "active", domains: { business: ["tooling"], program: [] } }]), run: vi.fn(async () => ({})) },
    jobs: { read: vi.fn(), start: vi.fn() },
    git: vi.fn(async (_cwd: string, args: string[]) => args[0] === "status" ? "" : "a".repeat(40)),
    vulnerability: vi.fn(async () => ({})),
  };
  return { session, deps, service: new DeveloperToolsService(deps as unknown as DeveloperToolDeps) };
}
describe("developer tools scope", () => {
  it("resolves tasks from the active checkout, never a caller-supplied project", async () => {
    const { service, deps } = fixture();
    await service.execute("own", { operation: "tasks_list" });
    expect(deps.tasks.findForProject).toHaveBeenCalledWith("/workspace/repo", undefined, null);
  });
  it("rejects stale branch binding before any task mutation", async () => {
    const { service, deps } = fixture();
    deps.inspect.mockResolvedValue({ repoPath: "/workspace/repo", branch: "main", repoOrigin: "LUDIARS/Concordia" });
    await expect(service.execute("own", { operation: "task_update", reference: "actio:1", status: "done" })).rejects.toThrow("checkout_binding_stale");
    expect(deps.tasks.updateStatus).not.toHaveBeenCalled();
  });
  it("does not update a task when owner verification fails", async () => {
    const { service, deps } = fixture();
    deps.tasks.read.mockRejectedValue(new Error("ownership mismatch"));
    await expect(service.execute("own", { operation: "task_update", reference: "actio:1", status: "done" })).rejects.toThrow();
    expect(deps.tasks.updateStatus).not.toHaveBeenCalled();
  });
  it("reports one failed integration without hiding other readiness results", async () => {
    const { service, deps } = fixture();
    deps.research.context.mockRejectedValue(new Error("down"));
    const result = await service.execute("own", { operation: "readiness" }) as { ready: boolean; items: { name: string; ready: boolean }[] };
    expect(result.ready).toBe(false);
    expect(result.items.find(item => item.name === "Anatomia")?.ready).toBe(false);
    expect(result.items.find(item => item.name === "Augur")?.ready).toBe(true);
  });
  it("journals the exact revision before executing an Augur bundle", async () => {
    const { service, deps } = fixture();
    await service.execute("own", { operation: "tests_run", bundle: "domain:tooling", request_id: "request", approval_reference: "human instruction" });
    expect(deps.jobs.start).toHaveBeenCalledWith("own", "request", { repo: "/workspace/repo", head: "a".repeat(40), bundle: "domain:tooling", approval_reference: "human instruction" }, expect.any(Function));
    expect(deps.augur.run).not.toHaveBeenCalled();
  });
  it("blocks dirty-checkout execution", async () => {
    const { service, deps } = fixture();
    deps.git.mockResolvedValueOnce("a".repeat(40)).mockResolvedValueOnce(" M src/file.ts");
    await expect(service.execute("own", { operation: "tests_run", bundle: "all", request_id: "request", approval_reference: "human" })).rejects.toThrow("clean_checkout_required");
    expect(deps.jobs.start).not.toHaveBeenCalled();
  });
});
