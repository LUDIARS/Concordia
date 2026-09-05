import { describe, expect, it } from "vitest";
import type { GithubIssueRunRow, GithubIssueRunsRepo } from "../db/github-issue-runs-repo.js";
import type { RevisorLocalPrSummary } from "../pr/revisor-local-pr-client.js";
import type { GithubGateway } from "./gh-cli.js";
import { advanceIssueRuns, decideRunTransition, findLocalPrForRun, isReviewPassed } from "./tracker.js";

function run(overrides: Partial<GithubIssueRunRow> = {}): GithubIssueRunRow {
  return {
    id: "run-1",
    repo_origin: "LUDIARS/Concordia",
    issue_number: 42,
    issue_title: "落ちる",
    issue_url: "https://github.com/LUDIARS/Concordia/issues/42",
    label: "Cc",
    actor: "neco",
    project_code: "Cc",
    repo_path: "E:/Document/Ars/Concordia",
    branch: "cc-issue-42",
    status: "running",
    delegation_run_id: "deleg-1",
    local_pr_id: null,
    github_pr_url: null,
    detail: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function localPr(overrides: Partial<RevisorLocalPrSummary> = {}): RevisorLocalPrSummary {
  return {
    id: "pr-1",
    number: 7,
    repository: "LUDIARS/Concordia",
    headRef: "cc-issue-42",
    status: "open",
    checkStatus: "test_ok",
    ...overrides,
  };
}

describe("decideRunTransition", () => {
  it("waits while the delegation is still working", () => {
    expect(decideRunTransition({
      run: run(),
      delegationStatus: "running",
      delegationError: null,
      localPr: null,
    })).toEqual({ kind: "wait" });
  });

  it("moves to pr_submitted as soon as the branch has a local PR", () => {
    expect(decideRunTransition({
      run: run(),
      delegationStatus: "running",
      delegationError: null,
      localPr: localPr({ checkStatus: "queued" }),
    })).toEqual({ kind: "mark", status: "pr_submitted", detail: null, localPrId: "pr-1" });
  });

  it("treats a completed delegation with no PR as a deliberate skip", () => {
    const transition = decideRunTransition({
      run: run(),
      delegationStatus: "completed",
      delegationError: null,
      localPr: null,
    });
    expect(transition).toMatchObject({ kind: "mark", status: "skipped", notify: "skipped" });
  });

  it("reports the delegation error when the run failed", () => {
    const transition = decideRunTransition({
      run: run(),
      delegationStatus: "failed",
      delegationError: "spawn refused",
      localPr: null,
    });
    expect(transition).toMatchObject({ kind: "mark", status: "failed", detail: "spawn refused" });
  });

  it("publishes only when the review passed with the PR still open", () => {
    expect(decideRunTransition({
      run: run({ status: "pr_submitted", local_pr_id: "pr-1" }),
      delegationStatus: "completed",
      delegationError: null,
      localPr: localPr(),
    })).toEqual({ kind: "publish" });
  });

  it("keeps waiting while the review is still running", () => {
    expect(decideRunTransition({
      run: run({ status: "pr_submitted", local_pr_id: "pr-1" }),
      delegationStatus: "completed",
      delegationError: null,
      localPr: localPr({ checkStatus: "running" }),
    })).toEqual({ kind: "wait" });
  });

  it("fails the run when the review did not pass", () => {
    expect(decideRunTransition({
      run: run({ status: "pr_submitted", local_pr_id: "pr-1" }),
      delegationStatus: "completed",
      delegationError: null,
      localPr: localPr({ checkStatus: "failed" }),
    })).toMatchObject({ kind: "mark", status: "failed", notify: "failed" });
  });

  it("does not open an empty PR when the local PR was merged first", () => {
    const transition = decideRunTransition({
      run: run({ status: "pr_submitted", local_pr_id: "pr-1" }),
      delegationStatus: "completed",
      delegationError: null,
      localPr: localPr({ status: "merged", checkStatus: "test_ok" }),
    });
    expect(transition).toMatchObject({ kind: "mark", status: "failed" });
  });

  it("never moves a terminal run", () => {
    expect(decideRunTransition({
      run: run({ status: "published" }),
      delegationStatus: "completed",
      delegationError: null,
      localPr: localPr(),
    })).toEqual({ kind: "wait" });
  });
});

describe("isReviewPassed", () => {
  it("requires both open and test_ok", () => {
    expect(isReviewPassed(localPr())).toBe(true);
    expect(isReviewPassed(localPr({ status: "closed" }))).toBe(false);
    expect(isReviewPassed(localPr({ checkStatus: "action_required" }))).toBe(false);
  });
});

describe("findLocalPrForRun", () => {
  it("matches on repository and branch before a PR id is recorded", () => {
    expect(findLocalPrForRun(run(), [localPr({ headRef: "other" }), localPr()])?.id).toBe("pr-1");
  });

  it("does not match another repository that reused the branch name", () => {
    expect(findLocalPrForRun(run(), [localPr({ repository: "LUDIARS/Memoria" })])).toBeNull();
  });

  it("sticks to the recorded PR id once it is known", () => {
    const bound = run({ local_pr_id: "pr-9" });
    expect(findLocalPrForRun(bound, [localPr()])).toBeNull();
    expect(findLocalPrForRun(bound, [localPr({ id: "pr-9" })])?.id).toBe("pr-9");
  });
});

describe("advanceIssueRuns", () => {
  it("coalesces overlapping tracker ticks so a reviewed branch is published once", async () => {
    const stored = run({ status: "pr_submitted", local_pr_id: "pr-1" });
    const runs: GithubIssueRunsRepo = {
      create: () => null,
      find: () => stored,
      findByIssue: () => stored,
      list: () => [stored],
      update: (_id, patch) => Object.assign(stored, {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.localPrId !== undefined ? { local_pr_id: patch.localPrId } : {}),
        ...(patch.githubPrUrl !== undefined ? { github_pr_url: patch.githubPrUrl } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      }),
      remove: () => false,
    };
    let releasePush: () => void = () => {};
    let pushes = 0;
    const pushBlocked = new Promise<void>((resolve) => { releasePush = resolve; });
    const github: GithubGateway = {
      listLabeledIssues: async () => [],
      findLabelActor: async () => null,
      commentOnIssue: async () => {},
      findPullRequestByHead: async () => null,
      createPullRequest: async () => "https://github.com/LUDIARS/Concordia/pull/1",
    };
    const deps = {
      runs,
      github,
      pusher: { push: async () => { pushes += 1; await pushBlocked; } },
      baseBranch: () => "main",
      findDelegationRun: () => null,
      listLocalPrs: async () => [localPr()],
    };

    const first = advanceIssueRuns(deps);
    const second = advanceIssueRuns(deps);
    expect(first).toBe(second);
    releasePush();
    await Promise.all([first, second]);
    expect(pushes).toBe(1);
  });
});
