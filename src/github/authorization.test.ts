import { describe, expect, it } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { authorizeIssueTrigger, findProjectByRepository } from "./authorization.js";

function project(overrides: Partial<ProjectCodeRow> = {}): ProjectCodeRow {
  return {
    code: "Cc",
    project: "Concordia",
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: "https://github.com/LUDIARS/Concordia.git",
    domain_review: 0,
    github_issue_workflow: 1,
    added_by: "api",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("findProjectByRepository", () => {
  it("matches a webhook owner/name against a stored clone URL", () => {
    expect(findProjectByRepository([project()], "LUDIARS/Concordia")?.code).toBe("Cc");
  });

  it("ignores case differences in the owner and name", () => {
    expect(findProjectByRepository([project()], "ludiars/concordia")?.code).toBe("Cc");
  });

  it("returns null for a repository nobody registered", () => {
    expect(findProjectByRepository([project()], "someone/else")).toBeNull();
  });
});

describe("authorizeIssueTrigger", () => {
  const trusted = ["neco"];

  it("allows an opted-in project labelled by a trusted actor", () => {
    const verdict = authorizeIssueTrigger({
      projects: [project()],
      repoOrigin: "LUDIARS/Concordia",
      actor: "neco",
      issueAuthor: "neco",
      trustedActors: trusted,
    });
    expect(verdict.kind).toBe("allow");
  });

  it("refuses a project that has not opted in", () => {
    const verdict = authorizeIssueTrigger({
      projects: [project({ github_issue_workflow: 0 })],
      repoOrigin: "LUDIARS/Concordia",
      actor: "neco",
      issueAuthor: "neco",
      trustedActors: trusted,
    });
    expect(verdict).toMatchObject({ kind: "reject", reason: "project_opted_out" });
  });

  it("refuses a repository that is not registered at all", () => {
    const verdict = authorizeIssueTrigger({
      projects: [],
      repoOrigin: "outsider/repo",
      actor: "neco",
      issueAuthor: "neco",
      trustedActors: trusted,
    });
    expect(verdict).toMatchObject({ kind: "reject", reason: "project_unregistered" });
  });

  it("holds an untrusted labeler for approval instead of dropping it", () => {
    const verdict = authorizeIssueTrigger({
      projects: [project()],
      repoOrigin: "LUDIARS/Concordia",
      actor: "drive-by",
      issueAuthor: "drive-by",
      trustedActors: trusted,
    });
    expect(verdict).toMatchObject({ kind: "needs_approval" });
  });

  it("accepts a trusted issue author even when someone else attached the label", () => {
    const verdict = authorizeIssueTrigger({
      projects: [project()],
      repoOrigin: "LUDIARS/Concordia",
      actor: "drive-by",
      issueAuthor: "neco",
      trustedActors: trusted,
    });
    expect(verdict.kind).toBe("allow");
  });

  it("accepts a trusted labeler on someone else's issue", () => {
    const verdict = authorizeIssueTrigger({
      projects: [project()],
      repoOrigin: "LUDIARS/Concordia",
      actor: "neco",
      issueAuthor: "drive-by",
      trustedActors: trusted,
    });
    expect(verdict.kind).toBe("allow");
  });

  it("treats an empty trusted list as everything needing approval, not everything allowed", () => {
    const verdict = authorizeIssueTrigger({
      projects: [project()],
      repoOrigin: "LUDIARS/Concordia",
      actor: "neco",
      issueAuthor: "neco",
      trustedActors: [],
    });
    expect(verdict).toMatchObject({ kind: "needs_approval" });
  });
});
