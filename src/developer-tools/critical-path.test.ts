import { describe, expect, it, vi } from "vitest";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import { criticalPath } from "./critical-path.js";
describe("Gantt model selection", () => {
  const binding = { ownerId: "own", teamId: null, subsidiaryId: null } as ActioBinding;
  it("uses the registered team, not the project code, for task Gantt", async () => {
    const request = vi.fn(async () => ({}));
    await criticalPath({ request }, { ...binding, teamId: "team-1" }, "LUDIARS/Cc");
    expect(request).toHaveBeenCalledWith(expect.anything(), "GET", "/api/teams/team-1/critical-path");
  });
  it("resolves a PM project by owner and Git origin without returning credentials", async () => {
    const request = vi.fn().mockResolvedValueOnce({ projects: [{ id: "pm-1", ownerId: "own", source: "github",
      sourceConfig: { owner: "LUDIARS", repo: "Cc", token: "private" } }] }).mockResolvedValueOnce({ criticalPath: ["task"] });
    const result = await criticalPath({ request }, binding, "https://github.com/LUDIARS/Cc.git");
    expect(result).toEqual({ criticalPath: ["task"] });
    expect(request).toHaveBeenLastCalledWith(binding, "GET", "/api/pm/projects/pm-1/analytics/critical-path");
  });
  it("rejects an explicitly requested project with the wrong owner", async () => {
    const request = vi.fn(async () => ({ projects: [{ id: "pm-1", ownerId: "other", source: "github",
      sourceConfig: { owner: "LUDIARS", repo: "Cc" } }] }));
    await expect(criticalPath({ request }, binding, "LUDIARS/Cc", "pm-1")).rejects.toThrow("pm_project_missing_or_ambiguous");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
