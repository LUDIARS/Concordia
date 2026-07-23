import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TasksRepo } from "../db/tasks-repo.js";
import { startPrReconciler } from "./reconcile.js";

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
});
