import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ControlBoardRepo, type ControlBoardEntry } from "./board-repo.js";

function entry(sessionId: string, patch: Partial<ControlBoardEntry> = {}): ControlBoardEntry {
  return {
    session_id: sessionId, project: "Cc", branch: "feat/x", followup_state: "task-active", fingerprint: "fp1",
    unchanged_count: 0, current_task: "task", side_summary: null, side_reported_at: null,
    last_activity_at: 10, updated_at: 100, ...patch,
  };
}

describe("ControlBoardRepo", () => {
  it("keeps exactly one row per session and overwrites it", () => {
    const repo = new ControlBoardRepo(makeTestDb());
    repo.upsert(entry("s1"));
    repo.upsert(entry("s1", { unchanged_count: 3, current_task: "next", updated_at: 200 }));
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: "s1", unchanged_count: 3, current_task: "next", updated_at: 200 });
  });

  it("keeps the digested fingerprint across overwrites", () => {
    const repo = new ControlBoardRepo(makeTestDb());
    repo.upsert(entry("s1"));
    repo.markDigested("s1", "fp1");
    repo.upsert(entry("s1", { updated_at: 300 }));
    expect(repo.find("s1")?.digested_fingerprint).toBe("fp1");
  });

  it("removes rows of sessions that are no longer active", () => {
    const repo = new ControlBoardRepo(makeTestDb());
    repo.upsert(entry("s1"));
    repo.upsert(entry("s2"));
    expect(repo.retainOnly(["s2"])).toBe(1);
    expect(repo.list().map((r) => r.session_id)).toEqual(["s2"]);
    repo.clear();
    expect(repo.list()).toEqual([]);
  });
});
