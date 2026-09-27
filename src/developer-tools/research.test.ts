import { describe, expect, it, vi } from "vitest";
import { ResearchTools } from "./research.js";
import { ToolServiceHttp } from "./service-http.js";
vi.mock("../taskflow/repository-identity.js", () => ({ mainRepositoryKey: async () => "/repo" }));
describe("research project identity", () => {
  it("matches exact Git root instead of guessing a similarly named repo", async () => {
    const request = vi.fn(async () => ({ projects: [{ id: "wrong", rootPath: "/repo-other" }, { id: "right", rootPath: "/repo" }] }));
    const tools = new ResearchTools({ request } as unknown as ToolServiceHttp);
    expect(await tools.anatomyProject("/worktree")).toBe("right");
  });
  it("does not implicitly choose an ambiguous project", async () => {
    const request = vi.fn(async () => ({ projects: [{ id: "a", rootPath: "/repo" }, { id: "b", rootPath: "/repo" }] }));
    await expect(new ResearchTools({ request } as unknown as ToolServiceHttp).anatomyProject("/repo")).rejects.toThrow("analysis_project_missing_or_ambiguous");
  });
  it("requires the Pf project to match repository origin, even with an explicit ID", async () => {
    const request = vi.fn(async () => ({ items: [{ id: "other", anatomiaRepo: "LUDIARS/Other" }], total: 1 }));
    await expect(new ResearchTools({ request } as unknown as ToolServiceHttp).specifications("LUDIARS/Cc", "other"))
      .rejects.toThrow("spec_project_missing_or_ambiguous");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("resolves a Pf registry ID only through the exact Anatomia repository root", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: "pf-cc", anatomiaRepo: "concordia" }], total: 1 })
      .mockResolvedValueOnce({ projects: [{ id: "concordia", rootPath: "/repo" }] })
      .mockResolvedValueOnce({ specifications: [] });
    await new ResearchTools({ request } as unknown as ToolServiceHttp).specifications("LUDIARS/Concordia", undefined, "/worktree");
    expect(request).toHaveBeenLastCalledWith("praeforma", "/api/projects/pf-cc/export/model.json");
  });
  it("disables cross-project and LLM expansion on impact requests", async () => {
    const request = vi.fn().mockResolvedValueOnce({ projects: [{ id: "cc", rootPath: "/repo" }] }).mockResolvedValueOnce({ plan: {} });
    await new ResearchTools({ request } as unknown as ToolServiceHttp).impact("/repo", "change task flow");
    expect(request).toHaveBeenLastCalledWith("anatomia", "/api/plan", { project: "cc", task: "change task flow", llm: false, map: false });
  });
});
