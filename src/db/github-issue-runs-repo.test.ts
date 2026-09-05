import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { makeGithubDeliveryLog, makeGithubIssueRunsRepo } from "./github-issue-runs-repo.js";

function open() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

const input = {
  repoOrigin: "LUDIARS/Concordia",
  issueNumber: 42,
  issueTitle: "落ちる",
  issueUrl: "https://github.com/LUDIARS/Concordia/issues/42",
  label: "Cc",
  actor: "neco",
  issueAuthor: "reporter",
  projectCode: "Cc",
  repoPath: "E:/Document/Ars/Concordia",
  branch: "cc-issue-42",
};

describe("GithubIssueRunsRepo", () => {
  it("creates one run per issue and refuses a second", () => {
    const db = open();
    const repo = makeGithubIssueRunsRepo(db);
    const created = repo.create(input);
    expect(created?.status).toBe("queued");
    // webhook とポーリングが同じ Issue を見ても 2 本目は立たない。
    expect(repo.create(input)).toBeNull();
    expect(repo.list()).toHaveLength(1);
    db.close();
  });

  it("keeps issues of different repositories apart", () => {
    const db = open();
    const repo = makeGithubIssueRunsRepo(db);
    repo.create(input);
    expect(repo.create({ ...input, repoOrigin: "LUDIARS/Memoria" })).not.toBeNull();
    db.close();
  });

  it("patches only the fields it is given", () => {
    const db = open();
    const repo = makeGithubIssueRunsRepo(db);
    const created = repo.create(input)!;
    repo.update(created.id, { status: "running", delegationRunId: "deleg-1" });
    const updated = repo.update(created.id, { localPrId: "pr-1" })!;
    expect(updated.status).toBe("running");
    expect(updated.delegation_run_id).toBe("deleg-1");
    expect(updated.local_pr_id).toBe("pr-1");
    db.close();
  });

  it("filters the listing by status", () => {
    const db = open();
    const repo = makeGithubIssueRunsRepo(db);
    const first = repo.create(input)!;
    repo.create({ ...input, issueNumber: 43 });
    repo.update(first.id, { status: "published" });
    expect(repo.list({ statuses: ["queued"] })).toHaveLength(1);
    expect(repo.list({ statuses: ["published"] })[0].id).toBe(first.id);
    db.close();
  });

  it("records the given status so approval-pending runs never start by accident", () => {
    const db = open();
    const repo = makeGithubIssueRunsRepo(db);
    const created = repo.create(input, "awaiting_approval")!;
    expect(created.status).toBe("awaiting_approval");
    expect(repo.list({ statuses: ["awaiting_approval"] })).toHaveLength(1);
    db.close();
  });

  it("lets only one concurrent approval claim the pending run", () => {
    const db = open();
    const repo = makeGithubIssueRunsRepo(db);
    const created = repo.create(input, "awaiting_approval")!;
    const claimed = repo.updateIfStatus(created.id, "awaiting_approval", { status: "queued" });
    expect(claimed?.status).toBe("queued");
    expect(repo.updateIfStatus(created.id, "awaiting_approval", { status: "queued" })).toBeNull();
    db.close();
  });

  it("lets a removed run be recreated (retry)", () => {
    const db = open();
    const repo = makeGithubIssueRunsRepo(db);
    const created = repo.create(input)!;
    expect(repo.remove(created.id)).toBe(true);
    expect(repo.create(input)).not.toBeNull();
    db.close();
  });
});

describe("github delivery log", () => {
  it("accepts a delivery once and rejects the redelivery", () => {
    const db = open();
    const log = makeGithubDeliveryLog(db);
    expect(log.markProcessed("d-1", "issues")).toBe(true);
    expect(log.markProcessed("d-1", "issues")).toBe(false);
    db.close();
  });

  it("prunes entries older than the retention window", () => {
    const db = open();
    const log = makeGithubDeliveryLog(db);
    log.markProcessed("old", "issues", 1_000);
    log.markProcessed("new", "issues", 100_000);
    expect(log.prune(10_000, 100_000)).toBe(1);
    expect(log.markProcessed("old", "issues", 100_000)).toBe(true);
    db.close();
  });
});
