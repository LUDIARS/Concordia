import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { StatsRepo } from "../src/db/stats-repo.js";

function fresh() {
  const db = makeTestDb();
  return new StatsRepo(db);
}

describe("StatsRepo", () => {
  let repo: StatsRepo;
  beforeEach(() => { repo = fresh(); });

  it("inserts and finds latest per session", () => {
    repo.insert({ session_id: "a", ts: 100, payload: { recent_work: "old" } });
    repo.insert({ session_id: "a", ts: 200, payload: { recent_work: "new" } });
    repo.insert({ session_id: "b", ts: 150, payload: { recent_work: "b-only" } });

    const latestA = repo.latest("a");
    expect(latestA?.ts).toBe(200);
    expect(JSON.parse(latestA!.payload).recent_work).toBe("new");

    const all = repo.latestPerSession();
    expect(all).toHaveLength(2);
    const a = all.find((s) => s.session_id === "a");
    const b = all.find((s) => s.session_id === "b");
    expect(a?.latest_ts).toBe(200);
    expect(b?.latest_ts).toBe(150);
  });

  it("returns history newest-first with limit", () => {
    for (let i = 1; i <= 5; i++) {
      repo.insert({ session_id: "a", ts: i * 10, payload: { i } });
    }
    const h = repo.history("a", 3);
    expect(h).toHaveLength(3);
    expect(h[0].ts).toBe(50);
    expect(h[2].ts).toBe(30);
  });

  it("lastTs returns null for unknown session", () => {
    expect(repo.lastTs("missing")).toBeNull();
    repo.insert({ session_id: "x", ts: 42, payload: {} });
    expect(repo.lastTs("x")).toBe(42);
  });

  it("purgeOlderThan deletes only old rows", () => {
    repo.insert({ session_id: "a", ts: 100, payload: {} });
    repo.insert({ session_id: "a", ts: 200, payload: {} });
    repo.insert({ session_id: "a", ts: 300, payload: {} });
    const n = repo.purgeOlderThan(200);
    expect(n).toBe(1);
    expect(repo.history("a", 10)).toHaveLength(2);
  });

  it("accepts both object and string payload", () => {
    const r1 = repo.insert({ session_id: "a", ts: 1, payload: { foo: 1 } });
    const r2 = repo.insert({ session_id: "a", ts: 2, payload: '{"bar":2}' });
    expect(JSON.parse(r1.payload).foo).toBe(1);
    expect(JSON.parse(r2.payload).bar).toBe(2);
  });
});
