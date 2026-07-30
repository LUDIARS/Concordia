import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { makeFederationOutboxRepo } from "./federation-outbox-repo.js";

describe("FederationOutboxRepo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("delivers in seq order and deletes acked rows", () => {
    const repo = makeFederationOutboxRepo(db, { maxRows: 100, ttlSec: 3600 }, () => 100);
    repo.enqueue("site-a", { n: 1 });
    repo.enqueue("site-a", { n: 2 });
    repo.enqueue("site-b", { n: 99 });

    const pending = repo.listPending("site-a", 0, 10);
    expect(pending.map((r) => JSON.parse(r.payload).n)).toEqual([1, 2]);
    expect(pending[0].seq).toBeLessThan(pending[1].seq);

    repo.ackUpTo("site-a", pending[1].seq);
    expect(repo.pendingCount("site-a")).toBe(0);
    // 他拠点のキューは影響を受けない。
    expect(repo.pendingCount("site-b")).toBe(1);
  });

  it("drops oldest rows over maxRows and reports the dropped count", () => {
    const repo = makeFederationOutboxRepo(db, { maxRows: 3, ttlSec: 3600 }, () => 100);
    for (let i = 1; i <= 3; i++) repo.enqueue("site-a", { n: i });
    const result = repo.enqueue("site-a", { n: 4 });
    expect(result.dropped).toBe(1);
    const remaining = repo.listPending("site-a", 0, 10).map((r) => JSON.parse(r.payload).n);
    expect(remaining).toEqual([2, 3, 4]);
  });

  it("drops rows past the TTL", () => {
    let now = 100;
    const repo = makeFederationOutboxRepo(db, { maxRows: 100, ttlSec: 50 }, () => now);
    repo.enqueue("site-a", { n: 1 });
    now = 200; // 1 件目は TTL 超過
    const result = repo.enqueue("site-a", { n: 2 });
    expect(result.dropped).toBe(1);
    expect(repo.listPending("site-a", 0, 10).map((r) => JSON.parse(r.payload).n)).toEqual([2]);
  });
});
