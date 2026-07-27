import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TasksRepo } from "../db/tasks-repo.js";
import {
  reviewModeFromCommitMessage,
  startPrReconciler,
} from "./reconcile.js";

function makeDeps() {
  const db = makeTestDb();
  const prs = new PrRecordsRepo(db);
  const sessions = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  sessions.insertSession({
    id: "session-1",
    provider: "codex-cli",
    repo_path: "/work/Concordia",
    repo_origin: "LUDIARS/Concordia",
    branch: "codex/x",
    host: "host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
  return { prs, sessions, tasks };
}

describe("startPrReconciler PR CI follow-up tasks", () => {
  beforeAll(() => {
    vi.stubEnv("CONCORDIA_PR_RECONCILE_ENABLED", "1");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("enqueues a report-only notice when a session-authored PR turns green", async () => {
    const deps = makeDeps();
    deps.prs.upsertFromStat({
      repo_origin: "LUDIARS/Concordia",
      number: 10,
      title: "Workflow fix",
      author_session_id: "session-1",
    });
    const reconciler = startPrReconciler({
      ...deps,
      nowSec: () => 1234,
      fetchPrsForOrigin: async () => [{
        number: 10,
        title: "Workflow fix",
        state: "OPEN",
        headRefOid: "head-sha-10",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }],
    });

    await reconciler.runOnce();
    reconciler.stop();

    const task = deps.tasks.pull("session-1").find((t) => t.kind === "pr-ci-followup");
    expect(task).toBeTruthy();
    const payload = JSON.parse(task!.payload) as { ci_status: string; instructions: string };
    expect(payload.ci_status).toBe("success");
    expect(payload.instructions).toContain("Report the status and stop");
    expect(payload.instructions).toContain("Do not run tests or merge");
    expect(deps.prs.findByKey("LUDIARS/Concordia", 10)?.head_sha).toBe("head-sha-10");
  });

  it("enqueues a report-only notice when a session-authored PR turns red", async () => {
    const deps = makeDeps();
    deps.prs.upsertFromStat({
      repo_origin: "LUDIARS/Concordia",
      number: 11,
      title: "Broken workflow",
      author_session_id: "session-1",
    });
    const reconciler = startPrReconciler({
      ...deps,
      nowSec: () => 1234,
      fetchPrsForOrigin: async () => [{
        number: 11,
        title: "Broken workflow",
        state: "OPEN",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      }],
    });

    await reconciler.runOnce();
    reconciler.stop();

    const task = deps.tasks.pull("session-1").find((t) => t.kind === "pr-ci-followup");
    expect(task).toBeTruthy();
    const payload = JSON.parse(task!.payload) as { ci_status: string; instructions: string };
    expect(payload.ci_status).toBe("failure");
    expect(payload.instructions).toContain("Report the failing status and stop");
    expect(payload.instructions).toContain("only when the user explicitly requests it");
  });

  it("does not enqueue repeatedly while CI status is unchanged", async () => {
    const deps = makeDeps();
    deps.prs.upsertFromStat({
      repo_origin: "LUDIARS/Concordia",
      number: 12,
      title: "Stable workflow",
      author_session_id: "session-1",
    });
    const reconciler = startPrReconciler({
      ...deps,
      nowSec: () => 1234,
      fetchPrsForOrigin: async () => [{
        number: 12,
        title: "Stable workflow",
        state: "OPEN",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }],
    });

    await reconciler.runOnce();
    expect(deps.tasks.pull("session-1").filter((t) => t.kind === "pr-ci-followup")).toHaveLength(1);
    await reconciler.runOnce();
    reconciler.stop();

    expect(deps.tasks.pull("session-1").filter((t) => t.kind === "pr-ci-followup")).toHaveLength(0);
  });

  it("enqueues Revisor after ordinary CI succeeds for a Cc-authored PR", async () => {
    const deps = makeDeps();
    deps.prs.upsertFromStat({
      repo_origin: "LUDIARS/Concordia",
      number: 13,
      title: "Review workflow",
      author_session_id: "session-1",
    });
    const enqueue = vi.fn(async () => ({ id: "job-13", status: "queued" }));
    const reconciler = startPrReconciler({
      ...deps,
      revisor: { enqueue },
      isCcWorkflowEnabled: () => true,
      resolveReviewMode: async () => "full",
      fetchPrsForOrigin: async () => [{
        number: 13,
        title: "Review workflow",
        url: "https://github.com/LUDIARS/Concordia/pull/13",
        state: "OPEN",
        headRefName: "feat/review",
        headRefOid: "a".repeat(40),
        baseRefName: "main",
        isCrossRepository: false,
        statusCheckRollup: [{
          name: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        }],
      }],
    });

    await reconciler.runOnce();
    reconciler.stop();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({
      repository: "LUDIARS/Concordia",
      number: 13,
      head_sha: "a".repeat(40),
      head_ref: "feat/review",
      head_repository: "LUDIARS/Concordia",
      base_ref: "main",
      pull_request_url: "https://github.com/LUDIARS/Concordia/pull/13",
      review_mode: "full",
    });
  });

  it("requests verification only for a Revisor autofix head", async () => {
    const deps = makeDeps();
    deps.prs.upsertFromStat({
      repo_origin: "LUDIARS/Concordia",
      number: 15,
      title: "Autofix verification",
      author_session_id: "session-1",
    });
    const enqueue = vi.fn(async () => ({ id: "job-15", status: "queued" }));
    const resolveReviewMode = vi.fn(async () => "verification" as const);
    const reconciler = startPrReconciler({
      ...deps,
      revisor: { enqueue },
      isCcWorkflowEnabled: () => true,
      resolveReviewMode,
      fetchPrsForOrigin: async () => [{
        number: 15,
        state: "OPEN",
        headRefName: "feat/review",
        headRefOid: "c".repeat(40),
        baseRefName: "main",
        isCrossRepository: false,
        statusCheckRollup: [{
          name: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        }],
      }],
    });

    await reconciler.runOnce();
    reconciler.stop();

    expect(resolveReviewMode).toHaveBeenCalledWith(
      "LUDIARS/Concordia",
      "c".repeat(40),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      review_mode: "verification",
    }));
  });

  it.each([
    {
      name: "Cc workflow is disabled",
      enabled: false,
      isCrossRepository: false,
      checks: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    {
      name: "the PR comes from a fork",
      enabled: true,
      isCrossRepository: true,
      checks: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }],
    },
    {
      name: "ordinary CI is still pending",
      enabled: true,
      isCrossRepository: false,
      checks: [{ name: "CI", status: "IN_PROGRESS" }],
    },
    {
      name: "the current head already has a Revisor Check",
      enabled: true,
      isCrossRepository: false,
      checks: [
        { name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Revisor review", status: "QUEUED" },
      ],
    },
  ])("does not enqueue Revisor when $name", async ({
    enabled,
    isCrossRepository,
    checks,
  }) => {
    const deps = makeDeps();
    deps.prs.upsertFromStat({
      repo_origin: "LUDIARS/Concordia",
      number: 14,
      title: "Ineligible review",
      author_session_id: "session-1",
    });
    const enqueue = vi.fn(async () => ({ id: "job-14", status: "queued" }));
    const reconciler = startPrReconciler({
      ...deps,
      revisor: { enqueue },
      isCcWorkflowEnabled: () => enabled,
      resolveReviewMode: async () => "full",
      fetchPrsForOrigin: async () => [{
        number: 14,
        state: "OPEN",
        headRefName: "feat/review",
        headRefOid: "b".repeat(40),
        baseRefName: "main",
        isCrossRepository,
        statusCheckRollup: checks,
      }],
    });

    await reconciler.runOnce();
    reconciler.stop();

    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("reviewModeFromCommitMessage", () => {
  it("detects only the explicit Revisor autofix trailer", () => {
    expect(reviewModeFromCommitMessage(
      "fix: apply review\n\nRevisor-Autofix: true\n",
    )).toBe("verification");
    expect(reviewModeFromCommitMessage(
      "docs: mention Revisor-Autofix: true in prose",
    )).toBe("full");
  });
});
