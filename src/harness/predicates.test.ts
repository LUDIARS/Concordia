import { describe, it, expect } from "vitest";
import { noMainPush, branchBeforeEdit, maxReposWarn, MAX_REPOS, type HarnessAction } from "./predicates.js";

const base: HarnessAction = { tool: "Bash" };

describe("noMainPush", () => {
  it("現在ブランチが main で ref 省略の push を deny", () => {
    const hit = noMainPush({ tool: "Bash", command: "git push", branch: "main" });
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("no-main-push");
  });

  it("origin main を明示した push を deny (ブランチ不問)", () => {
    expect(noMainPush({ tool: "Bash", command: "git push --force origin main", branch: "feat/x" })?.decision).toBe("deny");
    expect(noMainPush({ tool: "Bash", command: "git push origin HEAD:master" })?.decision).toBe("deny");
  });

  it("feature ブランチへの push は素通し", () => {
    expect(noMainPush({ tool: "Bash", command: "git push origin feat/x", branch: "feat/x" })).toBeNull();
    expect(noMainPush({ tool: "Bash", command: "git push", branch: "feat/x" })).toBeNull();
  });

  it("push でない git コマンド / 非 Bash は対象外", () => {
    expect(noMainPush({ tool: "Bash", command: "git status", branch: "main" })).toBeNull();
    expect(noMainPush({ tool: "Edit", filePath: "/a.ts", branch: "main" })).toBeNull();
  });
});

describe("branchBeforeEdit", () => {
  it("main 上の編集を warn", () => {
    const hit = branchBeforeEdit({ tool: "Edit", filePath: "/repo/a.ts", branch: "main" });
    expect(hit?.decision).toBe("warn");
    expect(hit?.rule).toBe("branch-before-edit");
  });

  it("feature ブランチ上の編集は素通し", () => {
    expect(branchBeforeEdit({ tool: "Write", filePath: "/repo/a.ts", branch: "feat/x" })).toBeNull();
  });

  it("ブランチ不明なら強制しない (null)", () => {
    expect(branchBeforeEdit({ tool: "Edit", filePath: "/repo/a.ts" })).toBeNull();
  });

  it("編集系でないツールは対象外", () => {
    expect(branchBeforeEdit({ tool: "Bash", command: "ls", branch: "main" })).toBeNull();
  });
});

describe("maxReposWarn", () => {
  it("上限超過で warn", () => {
    const repos = Array.from({ length: MAX_REPOS + 1 }, (_, i) => `/repo/${i}`);
    const hit = maxReposWarn({ ...base, editedRepos: repos });
    expect(hit?.decision).toBe("warn");
    expect(hit?.rule).toBe("max-repos");
  });

  it("重複を除いて数える (上限以内なら null)", () => {
    const repos = ["/a", "/a", "/b", "/b", "/c"];
    expect(maxReposWarn({ ...base, editedRepos: repos })).toBeNull();
  });

  it("editedRepos 無しは対象外", () => {
    expect(maxReposWarn(base)).toBeNull();
  });
});
