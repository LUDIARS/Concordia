import { describe, expect, it } from "vitest";
import { resolveSubmissionRoute } from "./submission-route.js";

const base = {
  workspaceRoots: ["E:/Document/Ars"],
  registered: true,
} as const;

describe("resolveSubmissionRoute", () => {
  it("sends the workspace root itself to direct-main, before any workflow", () => {
    const route = resolveSubmissionRoute({ ...base, repoPath: "E:/Document/Ars", workflow: "revisor" });
    expect(route.route).toBe("direct-main");
    expect(route.allowsGithubPr).toBe(false);
    expect(route.submitEndpoint).toBe(null);
  });

  it("treats a configured direct-main repository the same way", () => {
    const route = resolveSubmissionRoute({
      ...base, repoPath: "E:/Document/Ars/Villa", workflow: "revisor", directMainRepos: ["E:/Document/Ars/Villa"],
    });
    expect(route.route).toBe("direct-main");
  });

  it("keeps a Revisor Workflow project off GitHub and points at the Cc submit entry", () => {
    const route = resolveSubmissionRoute({ ...base, repoPath: "E:/Document/Ars/Concordia", workflow: "revisor" });
    expect(route).toMatchObject({
      route: "revisor-local-pr",
      allowsGithubPr: false,
      allowsBranchPush: false,
      submitEndpoint: "/v1/implementation-tools/submit",
    });
  });

  it("lets a GitHub Workflow project push its branch and open a PR", () => {
    const route = resolveSubmissionRoute({ ...base, repoPath: "E:/Document/Ars/SampleGame", workflow: "github" });
    expect(route).toMatchObject({ route: "github-pr", allowsGithubPr: true, allowsBranchPush: true });
  });

  it("refuses to guess for an unregistered repository and says which registration is missing", () => {
    const unknown = resolveSubmissionRoute({
      ...base, registered: false, repoPath: "E:/Document/Ars/Unknown", workflow: null,
    });
    expect(unknown.route).toBe("unregistered");
    expect(unknown.allowsGithubPr).toBe(false);
    expect(unknown.guidance).toContain("/projects に未登録");

    const noWorkflow = resolveSubmissionRoute({ ...base, repoPath: "E:/Document/Ars/Known", workflow: null });
    expect(noWorkflow.route).toBe("unregistered");
    expect(noWorkflow.guidance).toContain("workflow が未設定");
  });

  it("ignores path spelling differences when matching the workspace root", () => {
    const route = resolveSubmissionRoute({
      ...base, repoPath: "E:\\Document\\Ars\\", workflow: "github", workspaceRoots: ["E:/Document/Ars"],
    });
    expect(route.route).toBe("direct-main");
  });
});
