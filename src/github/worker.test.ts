import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { makeGithubIssueRunsRepo } from "../db/github-issue-runs-repo.js";
import { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { applyMigrations } from "../db/schema.js";
import type { GithubWorkflowConfig } from "./config.js";
import type { GithubGateway } from "./gh-cli.js";
import { pollLabeledIssues, type GithubIssueWorkerDeps } from "./worker.js";

function config(): GithubWorkflowConfig {
  return {
    label: () => "Cc",
    trustedActors: () => ["trusted-author"],
    pollIntervalMs: () => 300_000,
    baseBranch: () => "main",
    fixCallName: () => "github-issue-fix",
    webhookSecret: () => null,
    setWebhookSecret: () => {},
    clearWebhookSecret: () => {},
  };
}

function harness(labelActor: string | null) {
  const db = new Database(":memory:");
  applyMigrations(db);
  const projects = new ProjectCodesRepo(db);
  projects.register({
    code: "Cc",
    project: "Concordia",
    repoPath: "E:/Document/Ars/Concordia",
    repoOrigin: "https://github.com/LUDIARS/Concordia.git",
    addedBy: "test",
  });
  projects.setGithubIssueWorkflow("Cc", true);
  const runs = makeGithubIssueRunsRepo(db);
  let invoked = 0;
  const github: GithubGateway = {
    listLabeledIssues: async () => [{
      number: 42,
      title: "落ちる",
      body: "手順",
      url: "https://github.com/LUDIARS/Concordia/issues/42",
      labels: ["Cc"],
    }],
    findLabelActor: async () => labelActor,
    commentOnIssue: async () => {},
    createPullRequest: async () => "https://github.com/LUDIARS/Concordia/pull/1",
    findPullRequestByHead: async () => null,
  };
  const workflowConfig = config();
  const dispatch = {
    runs,
    projects,
    config: workflowConfig,
    github,
    invoke: async () => {
      invoked += 1;
      return {
        ok: true,
        run: { id: "deleg-1" },
        rendered_prompt: "",
        prompt_file_path: "",
      } as never;
    },
  };
  const deps = {
    runs,
    projects,
    config: workflowConfig,
    github,
    dispatch,
    pusher: { push: async () => {} },
    baseBranch: () => "main",
    findDelegationRun: () => null,
    listLocalPrs: async () => [],
  } satisfies GithubIssueWorkerDeps;
  return { db, deps, runs, invoked: () => invoked };
}

describe("pollLabeledIssues", () => {
  it("does not authorize an untrusted labeler", async () => {
    const { db, deps, runs, invoked } = harness("untrusted-labeler");
    const result = await pollLabeledIssues(deps);
    expect(result).toEqual({ scanned: 1, dispatched: 0 });
    expect(invoked()).toBe(0);
    expect(runs.list()).toEqual([]);
    db.close();
  });

  it("fails closed when the labeler cannot be resolved", async () => {
    const { db, deps, runs, invoked } = harness(null);
    const result = await pollLabeledIssues(deps);
    expect(result).toEqual({ scanned: 1, dispatched: 0 });
    expect(invoked()).toBe(0);
    expect(runs.list()).toEqual([]);
    db.close();
  });
});
