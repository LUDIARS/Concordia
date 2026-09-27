import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolTestJobs } from "./test-jobs.js";

const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function fixture() { const db = new Database(":memory:"); databases.push(db); return { db, jobs: new ToolTestJobs(db) }; }
describe("durable test request identity", () => {
  it("does not rerun a duplicate or interrupted request", async () => {
    const { jobs, db } = fixture();
    let finish!: (value: unknown) => void;
    const run = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const identity = { head: "a", approval_reference: "human instruction" };
    jobs.start("own", "id", identity, run);
    expect(new ToolTestJobs(db).start("own", "id", identity, run)).toMatchObject({ state: "outcome_unknown", request: identity });
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    finish({ passed: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(jobs.read("own", "id")).toMatchObject({ state: "completed", result: { passed: true } });
  });
  it("rejects changed request identity and conceals another session's result", () => {
    const { jobs } = fixture();
    jobs.start("own", "id", { head: "a" }, () => new Promise(() => {}));
    expect(() => jobs.start("own", "id", { head: "b" }, vi.fn())).toThrow("request_identity_conflict");
    expect(() => jobs.read("other", "id")).toThrow("test_request_not_found");
  });
});
