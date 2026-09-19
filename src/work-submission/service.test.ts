import { describe, expect, it } from "vitest";
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
  it("reads the workflow from the registration and names the project", () => {
    const resolved = service([row({ revisor_workflow: "revisor" })]).routeForRepo("E:/Document/Ars/Concordia");
    expect(resolved.route).toBe("revisor-local-pr");
    expect(resolved.project_code).toBe("Cc");
  });

  it("sends a GitHub Workflow project down the GitHub PR route", () => {
    const resolved = service([row({ code: "Sg", repo_path: "E:/Document/Ars/SampleGame", revisor_workflow: "github" })])
      .routeForRepo("E:/Document/Ars/SampleGame");
    expect(resolved).toMatchObject({ route: "github-pr", allowsGithubPr: true, project_code: "Sg" });
  });

  it("keeps the workspace root and configured repositories on direct-main", () => {
    const tools = service([row({ revisor_workflow: "revisor" })], ["E:/Document/Ars/Villa"]);
    expect(tools.routeForRepo("E:/Document/Ars").route).toBe("direct-main");
    expect(tools.routeForRepo("E:/Document/Ars/Villa").route).toBe("direct-main");
  });

  it("does not guess for a repository that has no registration", () => {
    const resolved = service([]).routeForRepo("E:/Document/Ars/Unknown");
    expect(resolved).toMatchObject({ route: "unregistered", allowsGithubPr: false, project_code: null });
  });

  // 登録は都度読む: 登録直後のセッションが「未登録」と言われないため。
  it("sees a registration added after construction", () => {
    const rows: ProjectCodeRow[] = [];
    const tools = service(rows);
    expect(tools.routeForRepo("E:/Document/Ars/Concordia").route).toBe("unregistered");
    rows.push(row({ revisor_workflow: "revisor" }));
    expect(tools.routeForRepo("E:/Document/Ars/Concordia").route).toBe("revisor-local-pr");
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
