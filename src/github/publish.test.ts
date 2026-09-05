import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { makeGithubIssueRunsRepo } from "../db/github-issue-runs-repo.js";
import type { RevisorLocalPrSummary } from "../pr/revisor-local-pr-client.js";
import type { GithubGateway } from "./gh-cli.js";
import { publishReviewedBranch } from "./publish.js";

function harness(options: {
  push?: () => Promise<void>;
  existingPr?: string | null;
  comment?: () => Promise<void>;
} = {}) {
  const db = new Database(":memory:");
  applyMigrations(db);
  const runs = makeGithubIssueRunsRepo(db);
  const run = runs.create({
    repoOrigin: "LUDIARS/Concordia",
    issueNumber: 42,
    issueTitle: "落ちる",
    issueUrl: "https://github.com/LUDIARS/Concordia/issues/42",
    label: "Cc",
    actor: "neco",
    projectCode: "Cc",
    repoPath: "E:/Document/Ars/Concordia",
    branch: "cc-issue-42",
  })!;
  const created: Array<{ head: string; base: string; body: string; title: string }> = [];
  const comments: string[] = [];
  const pushes: Array<{ branch: string }> = [];
  const github: GithubGateway = {
    listLabeledIssues: async () => [],
    findLabelActor: async () => null,
    commentOnIssue: async (_repo, _issue, body) => {
      comments.push(body);
      await options.comment?.();
    },
    createPullRequest: async (input) => {
      created.push({ head: input.head, base: input.base, body: input.body, title: input.title });
      return "https://github.com/LUDIARS/Concordia/pull/9";
    },
    findPullRequestByHead: async () => options.existingPr ?? null,
  };
  const deps = {
    runs,
    github,
    pusher: {
      push: async (input: { repoPath: string; branch: string; actor: string }) => {
        pushes.push({ branch: input.branch });
        if (options.push) await options.push();
      },
    },
    baseBranch: () => "main",
  };
  return { db, deps, run, runs, created, comments, pushes };
}

const localPr: RevisorLocalPrSummary = {
  id: "pr-1",
  number: 7,
  repository: "LUDIARS/Concordia",
  headRef: "cc-issue-42",
  status: "open",
  checkStatus: "test_ok",
  title: "落ちるのを直す",
  body: "null チェックを足した",
};

describe("publishReviewedBranch", () => {
  it("pushes the reviewed branch, opens a PR and links it back to the issue", async () => {
    const { db, deps, run, runs, created, comments, pushes } = harness();
    const outcome = await publishReviewedBranch(deps, run, localPr);
    expect(outcome.kind).toBe("published");
    expect(pushes).toEqual([{ branch: "cc-issue-42" }]);
    expect(created[0]).toMatchObject({ head: "cc-issue-42", base: "main" });
    // 修正内容 = 審査を通った local PR の説明。 Issue との紐付けは Closes で行う。
    expect(created[0].body).toContain("null チェックを足した");
    expect(created[0].body).toContain("Closes #42");
    expect(comments[0]).toContain("https://github.com/LUDIARS/Concordia/pull/9");
    const stored = runs.find(run.id)!;
    expect(stored.status).toBe("published");
    expect(stored.github_pr_url).toBe("https://github.com/LUDIARS/Concordia/pull/9");
    db.close();
  });

  it("reuses an existing PR for the same branch instead of opening a second one", async () => {
    const { db, deps, run, runs, created } = harness({
      existingPr: "https://github.com/LUDIARS/Concordia/pull/3",
    });
    await publishReviewedBranch(deps, run, localPr);
    expect(created).toEqual([]);
    expect(runs.find(run.id)?.github_pr_url).toBe("https://github.com/LUDIARS/Concordia/pull/3");
    db.close();
  });

  it("fails the run with the reason when the branch cannot be pushed", async () => {
    const { db, deps, run, runs, created } = harness({
      push: async () => { throw new Error("Branch push could not reach GitHub"); },
    });
    const outcome = await publishReviewedBranch(deps, run, localPr);
    expect(outcome.kind).toBe("failed");
    expect(created).toEqual([]);
    const stored = runs.find(run.id)!;
    expect(stored.status).toBe("failed");
    expect(stored.detail).toContain("Branch push could not reach GitHub");
    db.close();
  });

  it("keeps the run published when only the final Issue comment fails", async () => {
    const { db, deps, run, runs } = harness({
      comment: async () => { throw new Error("comment endpoint unavailable"); },
    });
    const outcome = await publishReviewedBranch(deps, run, localPr);
    expect(outcome.kind).toBe("published");
    expect(runs.find(run.id)?.status).toBe("published");
    expect(runs.find(run.id)?.github_pr_url).toBe("https://github.com/LUDIARS/Concordia/pull/9");
    db.close();
  });
});
