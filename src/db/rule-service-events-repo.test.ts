import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuleServiceEventsRepo, type ServiceEventInput } from "./rule-service-events-repo.js";
import { applyMigrations } from "./schema.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

const ev: ServiceEventInput = {
  source_event_id: "mm:release:42", service_code: "Mm", feature_key: "notes", event_kind: "release",
  title: "Memoria 1.2", summary: "notes search", url: null, scope_key: "hq", occurred_at: 100,
};

describe("RuleServiceEventsRepo", () => {
  it("receives an event once by source_event_id and consumes it once", () => {
    const db = new Database(":memory:");
    open.push(db);
    applyMigrations(db);
    const repo = new RuleServiceEventsRepo(db);
    const row = repo.receive(ev, 200)!;
    expect(repo.receive(ev, 201)).toBeNull();
    expect(repo.pending().map((e) => e.id)).toEqual([row.id]);
    expect(repo.consume(row.id, "rule-a")).toBe(true);
    expect(repo.consume(row.id, "rule-b")).toBe(false);
    expect(repo.pending()).toHaveLength(0);
  });

  it("ignores old pending events", () => {
    const db = new Database(":memory:");
    open.push(db);
    applyMigrations(db);
    const repo = new RuleServiceEventsRepo(db);
    repo.receive(ev, 200);
    expect(repo.ignoreOlderThan(300)).toBe(1);
    expect(repo.pending()).toHaveLength(0);
  });
});
