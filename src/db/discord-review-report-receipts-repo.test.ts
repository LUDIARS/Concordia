import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { makeDiscordReviewReportReceiptsRepo } from "./discord-review-report-receipts-repo.js";

describe("DiscordReviewReportReceiptsRepo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("never downgrades or forgets a delivered receipt", () => {
    const repo = makeDiscordReviewReportReceiptsRepo(db, "hq", () => 5_000);
    repo.markPending("thread-1", "k1", 1_000);
    repo.markDelivered("thread-1", "k1", "message-1");
    repo.markPending("thread-1", "k1", 2_000);
    repo.forgetPending("thread-1", "k1");
    repo.markPending("thread-1", "k2", 3_000);
    repo.forgetPending("thread-1", "k2");

    expect(repo.list("thread-1")).toEqual([
      { report_key: "k1", state: "delivered", message_id: "message-1", attempted_at: 1_000 },
    ]);
  });

  it("records former footer receipts together with the import marker, per scope", () => {
    const repo = makeDiscordReviewReportReceiptsRepo(db, "hq", () => 5_000);
    expect(repo.hasImportedLegacyReceipts("thread-1")).toBe(false);

    repo.importLegacyReceipts("thread-1", ["a", "b"]);

    expect(repo.hasImportedLegacyReceipts("thread-1")).toBe(true);
    expect(repo.list("thread-1")).toEqual([
      { report_key: "a", state: "delivered", message_id: null, attempted_at: 5_000 },
      { report_key: "b", state: "delivered", message_id: null, attempted_at: 5_000 },
    ]);
    const subsidiary = makeDiscordReviewReportReceiptsRepo(db, "subsidiary", () => 5_000);
    expect(subsidiary.hasImportedLegacyReceipts("thread-1")).toBe(false);
    expect(subsidiary.list("thread-1")).toEqual([]);
  });

  it("does not leave a partial import when the completion marker cannot be written", () => {
    const repo = makeDiscordReviewReportReceiptsRepo(db, "hq", () => 5_000);
    db.exec("DROP TABLE discord_review_report_threads");

    expect(() => repo.importLegacyReceipts("thread-1", ["a"])).toThrow();
    expect(repo.list("thread-1")).toEqual([]);
  });
});
