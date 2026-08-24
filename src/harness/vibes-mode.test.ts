import { describe, expect, it } from "vitest";
import { noOpTestInWorktree, noServiceStartInSession } from "./test-isolation.js";
import { vibesScope } from "./predicates.js";

describe("vibes mode harness", () => {
  it("does not let a vibes claim bypass service-start or worktree-test isolation", () => {
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

  it("denies edits outside scope and protected edits inside scope", () => {
    const base = { tool: "Edit", contractMode: "vibes" as const, contractScopeDirs: ["web/src"] };
    expect(vibesScope({ ...base, filePath: "web/src/pages/Home.tsx" })).toBeNull();
    expect(vibesScope({ ...base, filePath: "src/api.ts" })?.decision).toBe("deny");
    expect(vibesScope({ ...base, filePath: "web/src/schema.ts" })?.decision).toBe("deny");
  });

  it("treats dot as the repository root and rejects escaping scopes", () => {
    const base = { tool: "Edit", contractMode: "vibes" as const, cwd: "E:/repo" };
    expect(vibesScope({ ...base, contractScopeDirs: ["."], filePath: "E:/repo/src/a.ts" })).toBeNull();
    expect(vibesScope({ ...base, contractScopeDirs: ["."], filePath: "E:/other/a.ts" })?.decision).toBe("deny");
    expect(vibesScope({ ...base, contractScopeDirs: ["../other"], filePath: "E:/other/a.ts" })?.decision).toBe("deny");
  });
});
