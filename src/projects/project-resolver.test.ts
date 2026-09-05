import { describe, expect, it } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { createProjectResolver } from "./project-resolver.js";

function row(code: string, project: string, repoPath: string): ProjectCodeRow {
  return {
    code,
    project,
    repo_path: repoPath,
    repo_origin: null,
    domain_review: 0,
    github_issue_workflow: 0,
    added_by: "test",
    created_at: 1,
    updated_at: 1,
  };
}

const concordia = row("Cc", "Concordia", "E:/Document/Ars/Concordia");
const lictor = row("Li", "Lictor", "E:/Document/Ars/Lictor");
const castra = row("Ar", "Ars", "E:/Document/Ars");

describe("createProjectResolver", () => {
  it("returns no codes for an empty registry and never invents one from the path", () => {
    const resolver = createProjectResolver([]);
    expect(resolver.codesForRepos(["E:/Document/Ars/Concordia"])).toEqual([]);
    expect(resolver.targetFromText("[Cc] fix")).toBeNull();
  });

  it("falls back to the directory leaf only for codeForRepo", () => {
    const resolver = createProjectResolver([]);
    expect(resolver.codeForRepo("E:/Document/Ars/Concordia")).toBe("Concordia");
    expect(resolver.codeForRepo("")).toBe("Session");
  });

  it("resolves a registered repo path regardless of separator and trailing slash", () => {
    const resolver = createProjectResolver([concordia]);
    expect(resolver.codeForRepo("E:\\Document\\Ars\\Concordia")).toBe("Cc");
    expect(resolver.codeForRepo("E:/Document/Ars/Concordia/")).toBe("Cc");
  });

  it("resolves worktree leaves back to the owning project", () => {
    const resolver = createProjectResolver([concordia]);
    expect(resolver.codeForRepo("E:/Document/Ars/.wt-Concordia-inquiry")).toBe("Cc");
    expect(resolver.codeForRepo("E:/Document/Ars/Concordia-feature")).toBe("Cc");
  });

  it("keeps bare project codes case-sensitive", () => {
    const resolver = createProjectResolver([concordia]);
    expect(resolver.targetFromText("Cc spawn fix")?.project).toBe("Concordia");
    expect(resolver.targetFromText("cc spawn fix")).toBeNull();
    expect(resolver.targetFromText("[cc] spawn fix")).toBeNull();
  });

  it("drops the workspace root code when a real project is also present", () => {
    const resolver = createProjectResolver([concordia, lictor, castra]);
    expect(resolver.codesForRepos([
      "E:/Document/Ars",
      "E:/Document/Ars/Concordia",
      "E:/Document/Ars/Lictor",
    ])).toEqual(["Cc", "Li"]);
  });

  it("keeps the workspace root code when it is the only one", () => {
    const resolver = createProjectResolver([concordia, castra]);
    expect(resolver.codesForRepos(["E:/Document/Ars"])).toEqual(["Ar"]);
  });

  it("preserves first-touch order and de-duplicates", () => {
    const resolver = createProjectResolver([concordia, lictor]);
    expect(resolver.codesForRepos([
      "E:/Document/Ars/Lictor",
      "E:/Document/Ars/Concordia",
      "E:/Document/Ars/.wt-Lictor-fix",
    ])).toEqual(["Li", "Cc"]);
  });
});
