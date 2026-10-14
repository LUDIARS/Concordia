import { describe, expect, it, vi } from "vitest";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { WorkSubmissionService } from "./service.js";

const row = (overrides: Partial<ProjectCodeRow>): ProjectCodeRow => ({
  code: "Cc",
  project: "Concordia",
  repo_path: "E:/Document/Ars/Concordia",
  repo_origin: "https://github.com/LUDIARS/Concordia.git",
  ...overrides,
} as ProjectCodeRow);

function service(rows: ProjectCodeRow[], directMainRepos: string[] = []) {
  return new WorkSubmissionService({
    projectCodes: { list: () => rows } as never,
    resolveWorkspaceRoots: () => ["E:/Document/Ars"],
    directMainRepos: () => directMainRepos,
  });
}

describe("WorkSubmissionService.routeForRepo", () => {
  it("reads the workflow from the registration and names the project", async () => {
    const resolved = await service([row({ revisor_workflow: "revisor" })]).routeForRepo("E:/Document/Ars/Concordia");
    expect(resolved.route).toBe("revisor-local-pr");
    expect(resolved.project_code).toBe("Cc");
  });

  it("sends a GitHub Workflow project down the GitHub PR route", async () => {
    const resolved = await service([row({ code: "Sg", repo_path: "E:/Document/Ars/SampleGame", revisor_workflow: "github" })])
      .routeForRepo("E:/Document/Ars/SampleGame");
    expect(resolved).toMatchObject({ route: "github-pr", allowsGithubPr: true, project_code: "Sg" });
  });

  it("keeps the workspace root and configured repositories on direct-main", async () => {
    const tools = service([row({ revisor_workflow: "revisor" })], ["E:/Document/Ars/Villa"]);
    expect((await tools.routeForRepo("E:/Document/Ars")).route).toBe("direct-main");
    expect((await tools.routeForRepo("E:/Document/Ars/Villa")).route).toBe("direct-main");
  });

  it("does not guess for a repository that has no registration", async () => {
    const resolved = await service([]).routeForRepo("E:/Document/Ars/Unknown");
    expect(resolved).toMatchObject({ route: "unregistered", allowsGithubPr: false, project_code: null });
  });

  // 登録は都度読む: 登録直後のセッションが「未登録」と言われないため。
  it("sees a registration added after construction", async () => {
    const rows: ProjectCodeRow[] = [];
    const tools = service(rows);
    expect((await tools.routeForRepo("E:/Document/Ars/Concordia")).route).toBe("unregistered");
    rows.push(row({ revisor_workflow: "revisor" }));
    expect((await tools.routeForRepo("E:/Document/Ars/Concordia")).route).toBe("revisor-local-pr");
  });
});

describe("WorkSubmissionService.routeForRepo — worktree と許可リスト", () => {
  it("routes a linked worktree by its main checkout's registration", async () => {
    const tools = new WorkSubmissionService({
      projectCodes: { list: () => [row({ revisor_workflow: "revisor" })] } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      mainCheckout: (path) => (path.endsWith("Concordia-fix-x") ? "E:/Document/Ars/Concordia" : path),
    });
    expect(await tools.routeForRepo("E:/Document/Ars/Concordia-fix-x")).toMatchObject({ route: "revisor-local-pr", project_code: "Cc" });
  });

  // 2 つの設定がすれ違うと「push は通るのに提出は PR を要求する」。 その組み合わせだけを警告する。
  it("warns when a main-push allowlisted repository is not on direct-main", async () => {
    const allowlisted = (directMainRepos: string[]) => new WorkSubmissionService({
      projectCodes: { list: () => [row({ code: "Ag", repo_path: "C:/repos/AlphaGame", revisor_workflow: "github" })] } as never,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      directMainRepos: () => directMainRepos,
      mainPushAllowlist: () => ["AlphaGame"],
    }).routeForRepo("C:/repos/AlphaGame");
    expect((await allowlisted([])).consistency_warning).toContain("github-pr");
    expect(await allowlisted(["C:/repos/AlphaGame"])).not.toHaveProperty("consistency_warning");
  });

  it("does not warn for Castra / Villa style direct-main without the allowlist", async () => {
    const tools = service([], ["E:/Document/Ars/Villa"]);
    expect(await tools.routeForRepo("E:/Document/Ars/Villa")).not.toHaveProperty("consistency_warning");
  });
});

describe("WorkSubmissionService.submitGithubPr", () => {
  const github = () => ({
    pusher: { push: vi.fn(async () => undefined) },
    github: { findPullRequestByHead: vi.fn(async () => null), createPullRequest: vi.fn(async () => "https://github.com/Org/Game/pull/1") },
    baseBranch: () => "main",
  });
  const session = { id: "s1", repo_path: "E:/Work/Game", repo_origin: "https://github.com/Org/Game.git", branch: "feat/x" };

  it("submits with a title and body built from the branch commits", async () => {
    const deps = github();
    const tools = new WorkSubmissionService({ projectCodes: { list: () => [] } as never, resolveWorkspaceRoots: () => [],
      githubPr: deps, readPrContent: async () => ({ title: "feat: x", body: "b" }) });
    expect(await tools.submitGithubPr(session)).toMatchObject({ submitted: true, created: true });
    expect(deps.github.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ title: "feat: x", body: "b", head: "feat/x" }));
  });

  it("stops before pushing when the branch has no commits or GitHub is not wired", async () => {
    const deps = github();
    const empty = new WorkSubmissionService({ projectCodes: { list: () => [] } as never, resolveWorkspaceRoots: () => [],
      githubPr: deps, readPrContent: async () => null });
    expect(await empty.submitGithubPr(session)).toMatchObject({ submitted: false, reason: "no_commits" });
    expect(deps.pusher.push).not.toHaveBeenCalled();
    expect(await service([]).submitGithubPr(session)).toMatchObject({ submitted: false, reason: "github_pr_unavailable" });
  });
});

describe("WorkSubmissionService.commit", () => {
  it("refuses before touching git when the session has no bound repository", async () => {
    const outcome = await service([]).commit({ id: "s1" }, { message: "fix: x" });
    expect(outcome).toMatchObject({ ok: false, code: "run_cwd_unknown" });
  });

  it("refuses an empty message", async () => {
    const outcome = await service([]).commit({ id: "s1", repo_path: "E:/Document/Ars/Concordia" }, { message: "   " });
    expect(outcome).toMatchObject({ ok: false, code: "invalid_request" });
  });
});
