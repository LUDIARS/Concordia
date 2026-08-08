import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionMessageReadsRepo } from "./session-message-reads-repo.js";

let db: ReturnType<typeof makeTestDb>;
let repo: SessionMessageReadsRepo;

beforeEach(() => {
  db = makeTestDb();
  repo = new SessionMessageReadsRepo(db);
});

describe("SessionMessageReadsRepo", () => {
  it("returns null when no read state exists yet", () => {
    expect(repo.get("client-a", "s1")).toBeNull();
  });

  it("upsert then get round-trips the last_read_id", () => {
    repo.upsert("client-a", "s1", 42, 1000);
    const row = repo.get("client-a", "s1");
    expect(row?.last_read_id).toBe(42);
    expect(row?.updated_at).toBe(1000);
  });

  it("re-upsert for the same (client_id, session_id) overwrites in place", () => {
    repo.upsert("client-a", "s1", 10, 1000);
    repo.upsert("client-a", "s1", 20, 2000);
    expect(repo.get("client-a", "s1")).toEqual({
      client_id: "client-a",
      session_id: "s1",
      last_read_id: 20,
      updated_at: 2000,
    });
  });

  it("does not move a read cursor backward when stale clients race", () => {
    repo.upsert("client-a", "s1", 20, 2000);
    repo.upsert("client-a", "s1", 10, 3000);
    expect(repo.get("client-a", "s1")).toEqual({
      client_id: "client-a",
      session_id: "s1",
      last_read_id: 20,
      updated_at: 3000,
    });
  });

  it("read state is independent per client_id for the same session", () => {
    repo.upsert("client-a", "s1", 5, 1000);
    repo.upsert("client-b", "s1", 9, 1000);
    expect(repo.get("client-a", "s1")?.last_read_id).toBe(5);
    expect(repo.get("client-b", "s1")?.last_read_id).toBe(9);
  });

  it("read state is independent per session_id for the same client_id", () => {
    repo.upsert("client-a", "s1", 5, 1000);
    repo.upsert("client-a", "s2", 30, 1000);
    expect(repo.get("client-a", "s1")?.last_read_id).toBe(5);
    expect(repo.get("client-a", "s2")?.last_read_id).toBe(30);
  });
});
