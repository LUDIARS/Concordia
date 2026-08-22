import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { EscalationRepo } from "./escalation-repo.js";
import { SessionsRepo } from "./sessions-repo.js";

function seedSession(db: ReturnType<typeof makeTestDb>, id: string): void {
  new SessionsRepo(db).insertSession({
    id,
    provider: "claude-code",
    repo_path: "/work/Concordia",
    repo_origin: null,
    branch: "main",
    host: "host",
    started_at: 1_000,
    last_seen_at: 1_000,
    transcript_path: null,
    metadata: null,
  });
}

describe("escalation repo", () => {
  it("persists the state column and the audit row together", () => {
    const db = makeTestDb();
    seedSession(db, "s1");
    const repo = new EscalationRepo(db);

    const event = repo.start({ session_id: "s1", actor: "claude-code", reason: "Cc down", started_at: 2_000 });

    expect(event.reason).toBe("Cc down");
    expect(event.ended_at).toBeNull();
    expect(event.source).toBe("api");
    expect(repo.isEscalated("s1")).toBe(true);
    expect(repo.listEscalatedSessionIds()).toEqual(["s1"]);
  });

  it("does not open a second period while one is already open", () => {
    const db = makeTestDb();
    seedSession(db, "s1");
    const repo = new EscalationRepo(db);

    const first = repo.start({ session_id: "s1", actor: "a", reason: "one", started_at: 2_000 });
    const second = repo.start({ session_id: "s1", actor: "a", reason: "two", started_at: 2_500 });

    expect(second.id).toBe(first.id);
    expect(repo.listBySession("s1")).toHaveLength(1);
  });

  it("closes the period with the note and clears the state column", () => {
    const db = makeTestDb();
    seedSession(db, "s1");
    const repo = new EscalationRepo(db);
    repo.start({ session_id: "s1", actor: "a", reason: "Cc down", started_at: 2_000 });

    const ended = repo.end({ session_id: "s1", note: "restored", ended_at: 3_000 });

    expect(ended?.ended_at).toBe(3_000);
    expect(ended?.note).toBe("restored");
    expect(repo.isEscalated("s1")).toBe(false);
    expect(repo.findOpen("s1")).toBeNull();
  });

  it("clears the state column even when no open event exists", () => {
    const db = makeTestDb();
    seedSession(db, "s1");
    const repo = new EscalationRepo(db);
    db.prepare("UPDATE sessions SET escalation_mode = 1 WHERE id = ?").run("s1");

    expect(repo.end({ session_id: "s1" })).toBeNull();
    expect(repo.isEscalated("s1")).toBe(false);
  });

  it("recognises an already ingested transcript declaration by its start time", () => {
    const db = makeTestDb();
    seedSession(db, "s1");
    const repo = new EscalationRepo(db);
    repo.start({ session_id: "s1", actor: "transcript-record", reason: "outage", started_at: 2_000, source: "transcript" });

    expect(repo.hasEventStartedAt("s1", 2_000)).toBe(true);
    expect(repo.hasEventStartedAt("s1", 2_001)).toBe(false);
  });
});
