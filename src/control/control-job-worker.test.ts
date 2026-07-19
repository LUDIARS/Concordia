import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlJobsRepo } from "../db/control-jobs-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { applyMigrations } from "../db/schema.js";
import { ControlJobWorker, makeControlJobExecutor } from "./control-job-worker.js";

const databases: Database.Database[] = [];

function makeRepos(): { db: Database.Database; jobs: ControlJobsRepo; sessions: SessionsRepo } {
  const db = new Database(":memory:");
  databases.push(db);
  applyMigrations(db);
  return { db, jobs: new ControlJobsRepo(db), sessions: new SessionsRepo(db) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe("durable control job queue", () => {
  it("deduplicates an active stop for the same session role and pid", () => {
    const { jobs } = makeRepos();
    const input = {
      pid: 123,
      source: "test",
      sessionId: "s1",
      role: "lictor" as const,
      expectedCommand: null,
    };
    const first = jobs.enqueueStopProcess(input, 1_000);
    const second = jobs.enqueueStopProcess(input, 1_001);

    expect(second).toEqual({ id: first.id, deduplicated: true });
  });

  it("recovers a running job after its worker lease expires", () => {
    const { jobs } = makeRepos();
    const queued = jobs.enqueueStopProcess({
      pid: 123,
      source: "test",
      sessionId: "s1",
      role: "lictor",
      expectedCommand: null,
    }, 1_000);
    expect(jobs.claimNext("worker-a", 1_000, 1_000)?.attempts).toBe(1);

    const recovered = jobs.claimNext("worker-b", 1_000, 2_001);
    expect(recovered?.id).toBe(queued.id);
    expect(recovered?.attempts).toBe(2);
    expect(recovered?.lease_owner).toBe("worker-b");
  });

  it("retries transient failures and then persists success", async () => {
    const { jobs } = makeRepos();
    let now = 1_000;
    const queued = jobs.enqueueStopProcess({
      pid: 123,
      source: "test",
      sessionId: "s1",
      role: "lictor",
      expectedCommand: null,
    }, now);
    const executor = vi.fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, error: "busy" })
      .mockResolvedValueOnce({ ok: true, result: { method: "taskkill" } });
    const worker = new ControlJobWorker(jobs, { owner: "worker", now: () => now, executor });

    await worker.runOnce();
    expect(jobs.findById(queued.id)?.status).toBe("queued");
    now = 2_001;
    await worker.runOnce();

    expect(executor).toHaveBeenCalledTimes(2);
    expect(jobs.findById(queued.id)?.status).toBe("succeeded");
  });

  it("does not execute a job that expired while queued", async () => {
    const { jobs } = makeRepos();
    const queued = jobs.enqueueStopProcess({
      pid: 123,
      source: "test",
      sessionId: "s1",
      role: "lictor",
      expectedCommand: null,
      ttlMs: 1_000,
    }, 1_000);
    const executor = vi.fn();
    const worker = new ControlJobWorker(jobs, { owner: "worker", now: () => 2_001, executor });

    await worker.runOnce();

    expect(executor).not.toHaveBeenCalled();
    expect(jobs.findById(queued.id)?.status).toBe("failed");
    expect(jobs.findById(queued.id)?.last_error).toContain("expired");
  });

  it("validates session metadata before invoking the process-tree stop", async () => {
    const { jobs, sessions } = makeRepos();
    sessions.insertSession({
      id: "s1",
      provider: "claude-code",
      repo_path: "/repo",
      repo_origin: null,
      branch: null,
      host: "host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: JSON.stringify({ lictor_pid: 123 }),
    });
    const stopProcess = vi.fn(() => ({ ok: true as const, method: "taskkill" as const }));
    const executor = makeControlJobExecutor({ sessions, stopProcess, isProcessAlive: () => true });
    const queued = jobs.enqueueStopProcess({
      pid: 123,
      source: "test",
      sessionId: "s1",
      role: "lictor",
      expectedCommand: null,
    }, 1_000);
    const worker = new ControlJobWorker(jobs, { owner: "worker", now: () => 1_000, executor });

    await worker.runOnce();

    expect(stopProcess).toHaveBeenCalledWith(123);
    expect(jobs.findById(queued.id)?.status).toBe("succeeded");
  });
});
