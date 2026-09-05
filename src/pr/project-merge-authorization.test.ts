import { describe, expect, it } from "vitest";
import { decideProjectMergeAuthorization } from "./project-merge-authorization.js";

const registered = (...origins: string[]) => (repoOrigin: string): boolean =>
  origins.some((o) => o.toLowerCase() === repoOrigin.toLowerCase());

describe("decideProjectMergeAuthorization", () => {
  it("allows a PR whose repository is a registered project", () => {
    expect(
      decideProjectMergeAuthorization({
        localPrRepository: "LUDIARS/Concordia",
        isRegisteredProject: registered("LUDIARS/Concordia"),
      }),
    ).toEqual({ allowed: true, project: "LUDIARS/Concordia", via: "project_codes" });
  });

  it("does not look at the session at all — a Castra cwd session merges another project", () => {
    // 置き換え前は session.repo_origin が LUDIARS/Castra に固定され、 Ludellus の PR が
    // merge_project_scope_denied で止まっていた (2026-09-05)。 入力に session が無いことが
    // そのまま「cwd は無関係」の保証になる。
    expect(
      decideProjectMergeAuthorization({
        localPrRepository: "LUDIARS/Ludellus-Server",
        isRegisteredProject: registered("LUDIARS/Ludellus-Server"),
      }),
    ).toMatchObject({ allowed: true, project: "LUDIARS/Ludellus-Server" });
  });

  it("accepts a repo assigned to a team even when it has no project code", () => {
    const result = decideProjectMergeAuthorization({
      localPrRepository: "LUDIARS/Pagus",
      isRegisteredProject: () => false,
      isTeamRepo: registered("LUDIARS/Pagus"),
    });
    expect(result).toEqual({ allowed: true, project: "LUDIARS/Pagus", via: "team_repos" });
  });

  it("refuses a repository Concordia does not manage, and says why", () => {
    const result = decideProjectMergeAuthorization({
      localPrRepository: "someone-else/private-thing",
      isRegisteredProject: () => false,
      isTeamRepo: () => false,
    });
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toBe("project_not_registered");
    expect(result.allowed === false && result.detail).toContain("someone-else/private-thing");
  });

  it("refuses when Revisor cannot tell us the repository", () => {
    for (const repository of [null, undefined, "", "   "]) {
      const result = decideProjectMergeAuthorization({
        localPrRepository: repository,
        isRegisteredProject: () => true,
      });
      expect(result.allowed === false && result.reason).toBe("local_pr_repo_unknown");
    }
  });

  it("refuses non-GitHub URLs and local paths without reflecting them", () => {
    for (const repository of [
      "https://example.test/LUDIARS/Concordia.git",
      "E:/private/workspaces/Concordia",
      "../private-repo",
    ]) {
      const seen: string[] = [];
      const result = decideProjectMergeAuthorization({
        localPrRepository: repository,
        isRegisteredProject: (origin) => { seen.push(origin); return true; },
        isTeamRepo: (origin) => { seen.push(origin); return true; },
      });
      expect(result).toMatchObject({ allowed: false, reason: "local_pr_repo_unknown" });
      expect(result.allowed === false && result.detail).not.toContain(repository);
      expect(seen).toEqual([]);
    }
  });

  it("matches across URL / owner-repo spellings and letter case", () => {
    // 同じリポジトリが両表記で流れてくる。 表記差を別プロジェクト扱いにすると、
    // 直したいときに限ってマージできない元の不安定さに戻る。
    for (const spelling of [
      "https://github.com/LUDIARS/Concordia.git",
      "https://github.com/LUDIARS/Concordia",
      "git@github.com:LUDIARS/Concordia.git",
      "ludiars/concordia",
    ]) {
      const result = decideProjectMergeAuthorization({
        localPrRepository: spelling,
        isRegisteredProject: registered("LUDIARS/Concordia"),
      });
      expect(result.allowed, spelling).toBe(true);
    }
  });

  it("falls back to team assignment only when the project registry misses", () => {
    const seen: string[] = [];
    const result = decideProjectMergeAuthorization({
      localPrRepository: "LUDIARS/Concordia",
      isRegisteredProject: (o) => { seen.push(`codes:${o}`); return true; },
      isTeamRepo: (o) => { seen.push(`teams:${o}`); return true; },
    });
    expect(result).toMatchObject({ via: "project_codes" });
    expect(seen).toEqual(["codes:LUDIARS/Concordia"]);
  });
});
