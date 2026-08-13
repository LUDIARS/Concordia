import { describe, expect, it } from "vitest";
import { noOpTestInWorktree, noServiceStartInSession } from "./test-isolation.js";
import { vibesScope } from "./predicates.js";

describe("vibes mode harness", () => {
  it("allows operational commands only while the resolved claim is active", () => {
    const command = { tool: "Bash", command: "npm run dev", isWorktree: true };
    expect(noServiceStartInSession(command)?.decision).toBe("deny");
    expect(noServiceStartInSession({ ...command, vibesClaimActive: true })).toBeNull();
    expect(noOpTestInWorktree({ ...command, vibesClaimActive: true })).toBeNull();
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
