// @spec 最後に登録した作業プロジェクト
import { describe, expect, it } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { projectForRepoPath, selectStartupPolicyProject } from "./startup-policy-project.js";

const row = (code: string, project: string, repoPath: string, repoOrigin: string | null = null): ProjectCodeRow =>
  ({ code, project, repo_path: repoPath, repo_origin: repoOrigin, domain_review: 0 }) as ProjectCodeRow;

const rows = [
  row("Ar", "Castra", "E:/Document/Ars"),
  row("Cc", "Concordia", "E:/Document/Ars/Concordia", "https://github.com/LUDIARS/Concordia.git"),
  row("An", "Anatomia", "E:/Document/Ars/Anatomia", "https://github.com/LUDIARS/Anatomia.git"),
  row("Ll", "Ludellus-Server", "E:/Document/Ars/Ludellus-Server"),
  row("Lw", "Ludellus", "E:/Document/Ars/Ludellus"),
];
const roots = ["E:/Document/Ars"];

describe("selectStartupPolicyProject", () => {
  it("follows repo_path when target_project=An but the session works in Concordia", () => {
    const session = { target_project: "An", repo_path: "E:\\Document\\Ars\\Concordia", repo_origin: null };
    expect(selectStartupPolicyProject(rows, session, roots)?.code).toBe("Cc");
  });

  it("resolves a worktree of the registered repository before the stale target", () => {
    for (const repoPath of [
      "E:/Document/Ars/Concordia/.wt-startup-policy",
      "E:/Document/Ars/Concordia/.claude/worktrees/fix",
      "E:/Document/Ars/Concordia.wt-startup-policy-repo-root",
    ]) {
      expect(selectStartupPolicyProject(rows, { target_project: "An", repo_path: repoPath, repo_origin: null }, roots)?.code)
        .toBe("Cc");
    }
  });

  it("keeps target_project as the fallback for the workspace root and unregistered checkouts", () => {
    expect(selectStartupPolicyProject(rows, { target_project: "Cc", repo_path: "E:/Document/Ars", repo_origin: null }, roots)?.code)
      .toBe("Cc");
    expect(selectStartupPolicyProject(rows, { target_project: "Cc", repo_path: "E:/elsewhere/tool", repo_origin: null }, roots)?.code)
      .toBe("Cc");
  });

  it("does not fall back to the startup repository for an unknown target", () => {
    expect(selectStartupPolicyProject(rows, { target_project: "missing", repo_path: "E:/Document/Ars", repo_origin: null }, roots))
      .toBeNull();
  });

  it("resolves legacy sessions without a target by origin, then path", () => {
    expect(selectStartupPolicyProject(rows, { repo_path: "E:/clone/x", repo_origin: "git@github.com:LUDIARS/Anatomia.git" }, roots)?.code)
      .toBe("An");
    expect(selectStartupPolicyProject(rows, { repo_path: "E:/Document/Ars", repo_origin: null }, [])?.code).toBe("Ar");
  });
});

describe("projectForRepoPath", () => {
  it("prefers the exact or longest registered root", () => {
    expect(projectForRepoPath(rows, "E:/Document/Ars/Ludellus-Server")?.code).toBe("Ll");
    expect(projectForRepoPath(rows, "E:/Document/Ars/Ludellus-Server.wt-x")?.code).toBe("Ll");
    expect(projectForRepoPath(rows, "E:/Document/Ars/Ludellus.wt-x")?.code).toBe("Lw");
  });

  it("does not treat an ordinary subdirectory or unrelated repository as a worktree", () => {
    expect(projectForRepoPath(rows, "E:/Document/Ars/Concordia/src")).toBeNull();
    expect(projectForRepoPath(rows, "E:/Document/Ars/Revisor")).toBeNull();
    expect(projectForRepoPath(rows, "")).toBeNull();
  });
});
