import { describe, it, expect } from "vitest";
import { evaluateAction } from "./session-gate.js";

describe("evaluateAction", () => {
  it("違反なしは allow / blocked=false", () => {
    const v = evaluateAction({ tool: "Bash", command: "git status", branch: "feat/x" });
    expect(v.decision).toBe("allow");
    expect(v.blocked).toBe(false);
    expect(v.hits).toHaveLength(0);
  });

  it("main 直 push は deny / blocked=true", () => {
    const v = evaluateAction({ tool: "Bash", command: "git push", branch: "main" });
    expect(v.decision).toBe("deny");
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("no-main-push");
  });

  it("main 上編集は warn / blocked=false", () => {
    const v = evaluateAction({ tool: "Edit", filePath: "/repo/a.ts", branch: "main" });
    expect(v.decision).toBe("warn");
    expect(v.blocked).toBe(false);
  });

  it("deny と warn が同時なら最悪 (deny) を採る", () => {
    // main ブランチで push (deny) しつつ editedRepos 超過 (warn) を同時供給。
    const repos = Array.from({ length: 7 }, (_, i) => `/r/${i}`);
    const v = evaluateAction({ tool: "Bash", command: "git push origin main", branch: "main", editedRepos: repos });
    expect(v.decision).toBe("deny");
    expect(v.hits.length).toBeGreaterThanOrEqual(2);
  });
});
