import { describe, expect, it } from "vitest";
import { noOpTestInWorktree, noServiceStartInSession } from "./test-isolation.js";

describe("test isolation harness", () => {
  it("does not let a testing claim bypass service-start or worktree-test isolation", () => {
    const command = { tool: "Bash", command: "npm run dev", isWorktree: true };
    expect(noServiceStartInSession(command)?.decision).toBe("deny");
    expect(noOpTestInWorktree(command)?.decision).toBe("deny");
  });

  it("team settings test_policy=custos-unity keeps direct starts denied and routes them to Custos", () => {
    const command = { tool: "Bash", command: "npm run dev", isWorktree: true };
    const service = noServiceStartInSession({ ...command, teamTestPolicy: "custos-unity" as const });
    const operational = noOpTestInWorktree({ ...command, teamTestPolicy: "custos-unity" as const });
    expect(service).toEqual(expect.objectContaining({ rule: "custos-unity-required", decision: "deny" }));
    expect(operational).toEqual(expect.objectContaining({ rule: "custos-unity-required", decision: "deny" }));
    expect(service?.suggestion).toContain("Custos");
    expect(operational?.suggestion).toContain("Custos");
  });

  it("team settings test_policy=confirm-queue does not bypass the hard denies (fallback to current behavior)", () => {
    const command = { tool: "Bash", command: "npm run dev", isWorktree: true };
    expect(noServiceStartInSession({ ...command, teamTestPolicy: "confirm-queue" as const })?.decision).toBe("deny");
    expect(noOpTestInWorktree({ ...command, teamTestPolicy: "confirm-queue" as const })?.decision).toBe("deny");
  });
});
