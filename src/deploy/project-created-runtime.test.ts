import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { SqliteProjectNoticeLedger } from "./project-created-runtime.js";
import type { ProjectCreatedEvent } from "./project-created.js";

const event: ProjectCreatedEvent = {
  repository: "LUDIARS/Stilus",
  code: "St",
  project: "Stilus",
  repoUrl: "https://github.com/LUDIARS/Stilus",
};

function ledger() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return { db, ledger: new SqliteProjectNoticeLedger(db) };
}

describe("SqliteProjectNoticeLedger", () => {
  it("arms once and ignores a repeated registration of the same repository", () => {
    const { ledger: rows } = ledger();
    expect(rows.arm(event, 1_000)).toBe(true);
    expect(rows.arm({ ...event, code: "Xx" }, 2_000)).toBe(false);
    expect(rows.claim(event.repository, 3_000)).toEqual(event);
  });

  it("hands the armed project to exactly one claim", () => {
    const { ledger: rows } = ledger();
    rows.arm(event, 1_000);
    expect(rows.claim(event.repository, 2_000)).toEqual(event);
    expect(rows.claim(event.repository, 3_000)).toBeNull();
  });

  it("returns null for a repository that was never armed", () => {
    const { ledger: rows } = ledger();
    expect(rows.claim("LUDIARS/Concordia", 1_000)).toBeNull();
  });

  it("keeps the notified timestamp of the claim that won", () => {
    const { db, ledger: rows } = ledger();
    rows.arm(event, 1_000);
    rows.claim(event.repository, 2_000);
    const row = db.prepare("SELECT armed_at, notified_at FROM project_notice_ledger WHERE repository = ?")
      .get(event.repository) as { armed_at: number; notified_at: number };
    expect(row).toEqual({ armed_at: 1_000, notified_at: 2_000 });
  });
});
