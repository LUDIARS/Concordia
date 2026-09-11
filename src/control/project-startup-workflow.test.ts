// @spec 新規起動セッションのGitフック
import { expect, it } from "vitest";
import { selectProjectStartupWorkflow, renderProjectStartupWorkflow } from "./project-startup-workflow.js";
const record = { repository: "LUDIARS/Example", rootPath: "E:/Example", baseRef: "main", testCases: [] };

it.each(["https://github.com/LUDIARS/Example.git", "git@github.com:LUDIARS/Example.git", "LUDIARS/Example"])(
  "uses ordinary GitHub workflow for confirmed unregistered remote %s", (origin) => {
    expect(selectProjectStartupWorkflow([], "E:/Example", origin)).toBe("github");
  });
it("preserves explicit Revisor and GitHub registrations across worktrees", () => {
  expect(selectProjectStartupWorkflow([record], "E:/worktree", "LUDIARS/Example")).toBe("revisor");
  expect(selectProjectStartupWorkflow([{ ...record, workflow: "github" }], "E:/worktree", "LUDIARS/Example")).toBe("github");
});
it("does not authorize missing identities or conflicting registrations", () => {
  expect(selectProjectStartupWorkflow([], "E:/Example", null)).toBe("unknown");
  expect(selectProjectStartupWorkflow([], "E:/Example", "file:///tmp/repo")).toBe("unknown");
  expect(selectProjectStartupWorkflow([record, record], "E:/Example", "LUDIARS/Example")).toBe("unknown");
});
it("does not require a GitHub App for ordinary Git pushes", () => {
  expect(renderProjectStartupWorkflow("github")).toContain("GitHub Appはpushの必須条件ではありません");
});
