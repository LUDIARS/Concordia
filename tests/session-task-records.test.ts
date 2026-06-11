import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionTaskRecordsRepo } from "../src/db/session-task-records-repo.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";

function bootRepo() {
  const db = makeTestDb();
  return { db, records: new SessionTaskRecordsRepo(db), sessions: new SessionsRepo(db) };
}

function seedSession(sessions: SessionsRepo, id: string, repo_path = "/repo/A"): void {
  const now = Math.floor(Date.now() / 1000);
  sessions.insertSession({
    id,
    provider: "claude-code",
    repo_path,
    repo_origin: null,
    branch: null,
    host: "test",
    started_at: now,
    last_seen_at: now,
    transcript_path: null,
    metadata: null,
  });
}

describe("SessionTaskRecordsRepo", () => {
  let env: ReturnType<typeof bootRepo>;
  beforeEach(() => { env = bootRepo(); });

  it("first task_update inserts pending rows with first_seen_at = nowSec", () => {
    seedSession(env.sessions, "s1");
    const r = env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [
        { content: "fix bug A", activeForm: "Fixing bug A", status: "pending" },
        { content: "fix bug B", activeForm: "Fixing bug B", status: "in_progress" },
      ],
      nowSec: 1000,
    });
    expect(r.upserted).toBe(2);
    expect(r.completed_new).toBe(0);

    const list = env.records.listBySession("s1");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      task_text: "fix bug A",
      active_form: "Fixing bug A",
      status: "pending",
      first_seen_at: 1000,
      last_updated_at: 1000,
      completed_at: null,
      handled_by_session: null,
    });
    expect(list[1]).toMatchObject({ status: "in_progress" });
  });

  it("re-applying the same payload bumps last_updated_at but keeps first_seen_at", () => {
    seedSession(env.sessions, "s1");
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "pending" }],
      nowSec: 1000,
    });
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "pending" }],
      nowSec: 2000,
    });
    const list = env.records.listBySession("s1");
    expect(list).toHaveLength(1);
    expect(list[0].first_seen_at).toBe(1000);
    expect(list[0].last_updated_at).toBe(2000);
  });

  it("status transition to completed records completed_at + handled_by_session", () => {
    seedSession(env.sessions, "s1");
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "pending" }],
      nowSec: 1000,
    });
    const r = env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "completed" }],
      nowSec: 2000,
    });
    expect(r.completed_new).toBe(1);
    const [row] = env.records.listBySession("s1");
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBe(2000);
    expect(row.handled_by_session).toBe("s1");
  });

  it("re-opening a completed task does not erase completion history", () => {
    seedSession(env.sessions, "s1");
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "completed" }],
      nowSec: 1000,
    });
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "pending" }],
      nowSec: 2000,
    });
    const [row] = env.records.listBySession("s1");
    expect(row.status).toBe("pending");           // status reflects latest signal
    expect(row.completed_at).toBe(1000);          // but completion record survives
    expect(row.handled_by_session).toBe("s1");    // and the handler is preserved
    expect(row.last_updated_at).toBe(2000);
  });

  it("completed_new only counts FIRST transition, not re-applies", () => {
    seedSession(env.sessions, "s1");
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "completed" }],
      nowSec: 1000,
    });
    const r = env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "completed" }],
      nowSec: 2000,
    });
    expect(r.completed_new).toBe(0);
  });

  it("empty / non-string content is skipped silently", () => {
    seedSession(env.sessions, "s1");
    const r = env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [
        { content: "", status: "pending" },
        { content: "   ", status: "pending" },
        { content: 42 as unknown as string, status: "pending" },
        { content: "real task", status: "pending" },
      ],
      nowSec: 1000,
    });
    expect(r.upserted).toBe(1);
    expect(env.records.listBySession("s1")).toHaveLength(1);
  });

  it("unknown status defaults to 'pending'", () => {
    seedSession(env.sessions, "s1");
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: "A", status: "wat" }, { content: "B" }],
      nowSec: 1000,
    });
    const list = env.records.listBySession("s1");
    expect(list.every((r) => r.status === "pending")).toBe(true);
  });

  it("countBySessionStatus aggregates correctly", () => {
    seedSession(env.sessions, "s1");
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [
        { content: "A", status: "pending" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "completed" },
        { content: "D", status: "completed" },
      ],
      nowSec: 1000,
    });
    expect(env.records.countBySessionStatus("s1")).toEqual({
      pending: 1,
      in_progress: 1,
      completed: 2,
    });
  });

  it("listRemaining returns cross-session non-completed rows, repo filter works", () => {
    seedSession(env.sessions, "s1", "/repo/A");
    seedSession(env.sessions, "s2", "/repo/B");
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [
        { content: "A1 done", status: "completed" },
        { content: "A2 open", status: "pending" },
      ],
      nowSec: 1000,
    });
    env.records.applyTaskUpdate({
      session_id: "s2",
      todos: [{ content: "B1 open", status: "in_progress" }],
      nowSec: 2000,
    });

    const all = env.records.listRemaining({});
    expect(all.map((r) => r.task_text).sort()).toEqual(["A2 open", "B1 open"]);

    const onlyA = env.records.listRemaining({ repo_path: "/repo/A" });
    expect(onlyA.map((r) => r.task_text)).toEqual(["A2 open"]);
  });

  it("text > 1000 chars is truncated (DB row size cap)", () => {
    seedSession(env.sessions, "s1");
    const long = "x".repeat(2000);
    env.records.applyTaskUpdate({
      session_id: "s1",
      todos: [{ content: long, status: "pending" }],
      nowSec: 1000,
    });
    const [row] = env.records.listBySession("s1");
    expect(row.task_text.length).toBe(1000);
  });
});
