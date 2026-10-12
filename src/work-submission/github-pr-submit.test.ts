import { describe, expect, it, vi } from "vitest";
import { submitGithubPr, type GithubPrSubmitDeps, type GithubPrSubmitInput } from "./github-pr-submit.js";

function deps(overrides: { push?: () => Promise<void>; find?: () => Promise<string | null>; create?: () => Promise<string> } = {}) {
  const push = vi.fn(overrides.push ?? (async () => undefined));
  const findPullRequestByHead = vi.fn(overrides.find ?? (async () => null));
  const createPullRequest = vi.fn(overrides.create ?? (async () => "https://github.com/Org/Game/pull/7"));
  const value: GithubPrSubmitDeps = { pusher: { push }, github: { findPullRequestByHead, createPullRequest }, baseBranch: () => "main" };
  return { value, push, findPullRequestByHead, createPullRequest };
}

const input: GithubPrSubmitInput = {
  sessionId: "s1", repoPath: "E:/Work/Game", repoOrigin: "https://github.com/Org/Game.git",
  branch: "feat/x", title: "feat: x", body: "## Commits\n- feat: x",
};

describe("submitGithubPr", () => {
  it("pushes through Revisor, then creates the PR against the base", async () => {
    const d = deps();
    expect(await submitGithubPr(d.value, input)).toEqual({ submitted: true, prUrl: "https://github.com/Org/Game/pull/7", created: true });
    expect(d.push).toHaveBeenCalledWith({ repoPath: "E:/Work/Game", branch: "feat/x", actor: "concordia-session:s1" });
    expect(d.createPullRequest).toHaveBeenCalledWith({ repoOrigin: "Org/Game", head: "feat/x", base: "main", title: "feat: x", body: input.body });
  });

  it("does not open a second PR for a head that already has one (but still pushes new commits)", async () => {
    const d = deps({ find: async () => "https://github.com/Org/Game/pull/3" });
    expect(await submitGithubPr(d.value, input)).toEqual({ submitted: true, prUrl: "https://github.com/Org/Game/pull/3", created: false });
    expect(d.push).toHaveBeenCalledOnce();
    expect(d.createPullRequest).not.toHaveBeenCalled();
  });

  it("returns the PR created concurrently instead of failing on 'already exists'", async () => {
    const find = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce("https://github.com/Org/Game/pull/9");
    const d = deps({ find, create: async () => { throw new Error("a pull request for branch feat/x already exists"); } });
    expect(await submitGithubPr(d.value, input)).toEqual({ submitted: true, prUrl: "https://github.com/Org/Game/pull/9", created: false });
  });

  it("refuses protected branches and unknown origins before pushing", async () => {
    for (const branch of ["main", "master", "", null]) {
      const d = deps();
      expect(await submitGithubPr(d.value, { ...input, branch })).toMatchObject({ submitted: false, reason: "protected_branch" });
      expect(d.push).not.toHaveBeenCalled();
    }
    const d = deps();
    expect(await submitGithubPr(d.value, { ...input, repoOrigin: "E:/Work/Game" })).toMatchObject({ submitted: false, reason: "origin_unknown" });
    expect(d.push).not.toHaveBeenCalled();
  });

  it("classifies push failures so the caller can pick the next step", async () => {
    const cases: Array<[string, string]> = [
      ["HTTP 403: Resource not accessible", "auth"],
      ["remote: error: GH006: Protected branch update failed", "protected_branch"],
      ["Revisor CLI が見つからない", "push_failed"],
    ];
    for (const [message, reason] of cases) {
      const d = deps({ push: async () => { throw new Error(message); } });
      const result = await submitGithubPr(d.value, input);
      expect(result).toMatchObject({ submitted: false, reason });
      expect(d.createPullRequest).not.toHaveBeenCalled();
    }
  });

  it("separates PR creation failures from push failures", async () => {
    const auth = deps({ create: async () => { throw new Error("gh: authentication required (HTTP 401)"); } });
    expect(await submitGithubPr(auth.value, input)).toMatchObject({ submitted: false, reason: "auth" });
    const other = deps({ create: async () => { throw new Error("gh pr create did not return a URL"); } });
    expect(await submitGithubPr(other.value, input)).toMatchObject({ submitted: false, reason: "pr_create_failed" });
  });
});
